"""Exercise a frozen bundle with an empty PATH and no development environment."""

import json
import os
import platform
import queue
import subprocess
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARCH = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "x64", "amd64": "x64"}[
    platform.machine().lower()
]
PLATFORM = {"Darwin": "darwin", "Windows": "win32", "Linux": "linux"}[platform.system()]
DIRECTORY = ROOT / "dist" / f"{PLATFORM}-{ARCH}" / "lingo-agent"
EXECUTABLE = DIRECTORY / ("lingo-agent.exe" if PLATFORM == "win32" else "lingo-agent")


class Client:
    def __init__(self, cwd):
        env = {"PATH": "", "LANG": "en_US.UTF-8", "PYINSTALLER_RESET_ENVIRONMENT": "1"}
        for key in ["SystemRoot", "WINDIR", "TEMP", "TMP"]:
            if key in os.environ:
                env[key] = os.environ[key]
        self.process = subprocess.Popen(
            [str(EXECUTABLE)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=cwd,
        )
        self.queue = queue.Queue()
        self.instance = f"smoke-{self.process.pid}"

        def read():
            for line in self.process.stdout:
                self.queue.put(json.loads(line))
            self.queue.put(None)

        threading.Thread(target=read, daemon=True).start()

    def send(self, kind, **payload):
        data = {"v": 4, "instanceId": self.instance, "type": kind, **payload}
        self.process.stdin.write((json.dumps(data) + "\n").encode())
        self.process.stdin.flush()

    def receive(self, kind):
        frame = self.queue.get(timeout=30)
        assert frame is not None, self.process.stderr.read().decode()
        assert frame["type"] == kind, frame
        assert frame["instanceId"] == self.instance
        return frame

    def start(self):
        started = time.monotonic()
        self.send("hello")
        self.receive("ready")
        return (time.monotonic() - started) * 1000

    def run(self, run_id, task="conversation"):
        self.send(
            "run",
            runId=run_id,
            snapshot={
                "task": task,
                "messages": [{"role": "user", "content": "Hi"}],
                "outputLanguage": "zh-CN",
                "targetLanguage": "en",
                "allowedOperations": [f"{task}.prepare", f"model.{task}"]
                if task in ("vocabulary", "phrase")
                else ["model.reply"],
                "budget": {
                    "timeoutMs": 5000,
                    "maxModelCalls": 20 if task in ("vocabulary", "phrase") else 1,
                    "maxToolCalls": 1 if task in ("vocabulary", "phrase") else 0,
                    "maxSteps": 32 if task in ("vocabulary", "phrase") else 4,
                    "maxInputChars": 8192,
                    "maxOutputChars": 32768 if task in ("vocabulary", "phrase") else 100,
                },
            },
        )
        return self.receive("host_call")


with tempfile.TemporaryDirectory(prefix="lingo-bundle-") as cwd:
    client = Client(cwd)
    try:
        cold_ms = client.start()
        if PLATFORM != "win32":
            idle_rss_kib = int(
                subprocess.check_output(
                    ["/bin/ps", "-o", "rss=", "-p", str(client.process.pid)]
                ).strip()
            )

            def cpu_seconds():
                value = (
                    subprocess.check_output(
                        ["/bin/ps", "-o", "time=", "-p", str(client.process.pid)]
                    )
                    .decode()
                    .strip()
                )
                return sum(
                    float(part) * 60**index for index, part in enumerate(reversed(value.split(":")))
                )

            before = cpu_seconds()
            started_idle = time.monotonic()
            time.sleep(0.5)
            idle_cpu_percent = round(
                (cpu_seconds() - before) / (time.monotonic() - started_idle) * 100, 2
            )
        else:
            idle_rss_kib = None
            idle_cpu_percent = None
        call = client.run("stream")
        for seq, event in enumerate(
            [{"type": "reasoning", "delta": "temporary"}, {"type": "text", "delta": "你好"}], 1
        ):
            client.send("host_chunk", runId="stream", callId=call["callId"], seq=seq, event=event)
            assert client.receive("event")["event"] == event
        client.send("host_result", runId="stream", callId=call["callId"], result={"text": "你好"})
        assert client.receive("result")["text"] == "你好"
        call = client.run("vocabulary", task="vocabulary")
        assert call["operation"] == "vocabulary.prepare"
        client.send(
            "host_result",
            runId="vocabulary",
            callId=call["callId"],
            result={
                "items": [
                    {"inputIndex": i, "term": f"word{i}", "status": "pending"} for i in range(20)
                ]
            },
        )
        pending = [client.receive("host_call"), client.receive("host_call")]
        indices = []
        for index in range(20):
            call = pending.pop(0)
            assert call["operation"] == "model.vocabulary"
            assert "Simplified Chinese (zh-CN)" in call["args"]["systemPrompt"]
            term_index = call["args"]["inputIndex"]
            indices.append(term_index)
            client.send(
                "host_result",
                runId="vocabulary",
                callId=call["callId"],
                result={"inputIndex": term_index, "status": "staged"},
            )
            if index < 18:
                pending.append(client.receive("host_call"))
        assert sorted(indices) == list(range(20))
        assert client.receive("vocabulary_result")["result"] == {
            "completedIndices": list(range(20))
        }
        call = client.run("phrase", task="phrase")
        assert call["operation"] == "phrase.prepare"
        client.send(
            "host_result",
            runId="phrase",
            callId=call["callId"],
            result={
                "items": [
                    {"inputIndex": i, "phrase": f"phrase {i}", "status": "pending"}
                    for i in range(20)
                ]
            },
        )
        pending = [client.receive("host_call"), client.receive("host_call")]
        indices = []
        for index in range(20):
            call = pending.pop(0)
            assert call["operation"] == "model.phrase"
            assert "Simplified Chinese (zh-CN)" in call["args"]["systemPrompt"]
            phrase_index = call["args"]["inputIndex"]
            indices.append(phrase_index)
            client.send(
                "host_result",
                runId="phrase",
                callId=call["callId"],
                result={"inputIndex": phrase_index, "status": "staged"},
            )
            if index < 18:
                pending.append(client.receive("host_call"))
        assert sorted(indices) == list(range(20))
        assert client.receive("phrase_result")["result"] == {"completedIndices": list(range(20))}
        call = client.run("cancel")
        client.send("cancel", runId="cancel")
        client.receive("cancelled")
        client.send("host_result", runId="cancel", callId=call["callId"], result={"text": "late"})
        client.run("crash")
        client.process.kill()
        client.process.wait(timeout=5)
    finally:
        if client.process.poll() is None:
            client.process.kill()
            client.process.wait(timeout=5)
    client = Client(cwd)
    try:
        restart_ms = client.start()
        client.run("shutdown-with-active-run")
        client.send("shutdown")
        client.receive("cancelled")
        client.receive("shutdown_ack")
        assert client.process.wait(timeout=5) == 0, client.process.stderr.read().decode()
    finally:
        if client.process.poll() is None:
            client.process.kill()
            client.process.wait(timeout=5)

size = sum(p.stat().st_size for p in DIRECTORY.rglob("*") if p.is_file() and not p.is_symlink())
print(
    json.dumps(
        {
            "platform": PLATFORM,
            "arch": ARCH,
            "bytes": size,
            "coldStartMs": round(cold_ms, 1),
            "restartMs": round(restart_ms, 1),
            "idleRssKiB": idle_rss_kib,
            "idleCpuPercent": idle_cpu_percent,
            "checks": [
                "empty-PATH",
                "handshake",
                "stream",
                "vocabulary-20-terms",
                "phrase-20-items",
                "cancel",
                "late-result",
                "crash",
                "restart",
                "shutdown",
            ],
        },
        indent=2,
    )
)
