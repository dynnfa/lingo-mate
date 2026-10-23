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
        data = {"v": 10, "instanceId": self.instance, "type": kind, **payload}
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

    def run(self, run_id, task="conversation", content="Hi", output_language="zh-CN"):
        if task == "vocabulary-practice-review":
            self.send(
                "run",
                runId=run_id,
                snapshot={
                    "task": task,
                    "messages": [{"role": "user", "content": "Bound vocabulary practice"}],
                    "outputLanguage": output_language,
                    "targetLanguage": "en",
                    "allowedOperations": [
                        "vocabulary-practice.prepare",
                        "model.vocabulary-practice-review",
                        "vocabulary-practice.apply",
                        "vocabulary-practice.correct",
                        "vocabulary-practice.finish",
                    ],
                    "budget": {
                        "timeoutMs": 120000,
                        "maxModelCalls": 8,
                        "maxToolCalls": 10,
                        "maxSteps": 18,
                        "maxInputChars": 65536,
                        "maxOutputChars": 4096,
                    },
                },
            )
            return self.receive("host_call")
        if task in ("sentence-practice-hints", "sentence-practice-review"):
            self.send(
                "run",
                runId=run_id,
                snapshot={
                    "task": task,
                    "messages": [{"role": "user", "content": "Bound sentence practice"}],
                    "outputLanguage": output_language,
                    "targetLanguage": "en",
                    "allowedOperations": ["sentence-practice.prepare", f"model.{task}"],
                    "budget": {
                        "timeoutMs": 120000,
                        "maxModelCalls": 1,
                        "maxToolCalls": 1,
                        "maxSteps": 2,
                        "maxInputChars": 65536,
                        "maxOutputChars": 1024,
                    },
                },
            )
            return self.receive("host_call")
        self.send(
            "run",
            runId=run_id,
            snapshot={
                "task": task,
                "messages": [{"role": "user", "content": content}],
                "outputLanguage": output_language,
                "targetLanguage": "en",
                "allowedOperations": [
                    "synonym.prepare",
                    "model.synonym",
                    "synonym.apply",
                    "synonym.finish",
                ]
                if task == "synonym"
                else [f"{task}.prepare", f"model.{task}"]
                if task in ("vocabulary", "phrase", "explore-phrase", "explore-vocabulary")
                else ["model.title"]
                if task == "conversation-title"
                else ["model.reply"],
                "budget": {
                    "timeoutMs": 120000 if task == "conversation-title" else 5000,
                    "maxModelCalls": 3
                    if task in ("explore-phrase", "explore-vocabulary")
                    else 1040
                    if task == "synonym"
                    else 20
                    if task in ("vocabulary", "phrase", "explore-phrase", "explore-vocabulary")
                    else 1,
                    "maxToolCalls": 1061
                    if task == "synonym"
                    else 1
                    if task in ("vocabulary", "phrase", "explore-phrase", "explore-vocabulary")
                    else 0,
                    "maxSteps": 8
                    if task in ("explore-phrase", "explore-vocabulary")
                    else 2200
                    if task == "synonym"
                    else 32
                    if task in ("vocabulary", "phrase", "explore-phrase", "explore-vocabulary")
                    else 1
                    if task == "conversation-title"
                    else 4,
                    "maxInputChars": 32768 if task == "conversation-title" else 8192,
                    "maxOutputChars": 524288
                    if task == "synonym"
                    else 32768
                    if task in ("vocabulary", "phrase", "explore-phrase", "explore-vocabulary")
                    else 80
                    if task == "conversation-title"
                    else 100,
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
        for locale, language in (("zh-CN", "Simplified Chinese"), ("en", "English")):
            for kinds in (("complete",), ("missing_marks", "tools", "complete")):
                run_id = f"vocabulary-practice-{locale}-{len(kinds)}"
                call = client.run(run_id, task="vocabulary-practice-review", output_language=locale)
                assert call["operation"] == "vocabulary-practice.prepare"
                client.send(
                    "host_result", runId=run_id, callId=call["callId"], result={"inputChars": 1000}
                )
                for round_, kind in enumerate(kinds, 1):
                    call = client.receive("host_call")
                    assert call["operation"] == "model.vocabulary-practice-review"
                    assert call["args"]["round"] == round_
                    assert language in call["args"]["systemPrompt"]
                    client.send(
                        "host_result",
                        runId=run_id,
                        callId=call["callId"],
                        result={"round": round_, "kind": kind, "inputChars": 3000},
                    )
                    call = client.receive("host_call")
                    suffix = {"complete": "finish", "tools": "apply", "missing_marks": "correct"}[
                        kind
                    ]
                    assert call["operation"] == f"vocabulary-practice.{suffix}"
                    if kind == "complete":
                        assert call["args"] == {"round": round_, "reason": "terminal"}
                        receipt = {"completed": True, "rounds": round_}
                    else:
                        if kind == "missing_marks":
                            assert language in call["args"]["instruction"]
                        receipt = {"round": round_, "applied": True}
                    client.send("host_result", runId=run_id, callId=call["callId"], result=receipt)
                assert client.receive("vocabulary_practice_result")["result"] == {
                    "completed": True,
                    "rounds": len(kinds),
                }
        call = client.run("vocabulary-practice-cancel", task="vocabulary-practice-review")
        client.send(
            "host_result", runId=call["runId"], callId=call["callId"], result={"inputChars": 1000}
        )
        call = client.receive("host_call")
        client.send("cancel", runId=call["runId"])
        client.receive("cancelled")
        client.send(
            "host_result",
            runId=call["runId"],
            callId=call["callId"],
            result={"round": 1, "kind": "complete", "inputChars": 3000},
        )
        call = client.run("vocabulary-practice-failed", task="vocabulary-practice-review")
        client.send(
            "host_error", runId=call["runId"], callId=call["callId"], code="AGENT_HOST_ERROR"
        )
        assert client.receive("error")["code"] == "AGENT_HOST_ERROR"
        for task in ("sentence-practice-hints", "sentence-practice-review"):
            for locale, language in (("zh-CN", "Simplified Chinese"), ("en", "English")):
                run_id = f"{task}-{locale}"
                call = client.run(run_id, task=task, output_language=locale)
                assert call["operation"] == "sentence-practice.prepare"
                client.send(
                    "host_result", runId=run_id, callId=call["callId"], result={"inputChars": 1000}
                )
                call = client.receive("host_call")
                assert call["operation"] == f"model.{task}"
                assert language in call["args"]["systemPrompt"]
                assert "English" in call["args"]["systemPrompt"]
                client.send(
                    "host_result", runId=run_id, callId=call["callId"], result={"completed": True}
                )
                assert client.receive("sentence_practice_result")["result"] == {"completed": True}
            cancel_id = f"{task}-cancel"
            call = client.run(cancel_id, task=task)
            client.send(
                "host_result", runId=cancel_id, callId=call["callId"], result={"inputChars": 1000}
            )
            call = client.receive("host_call")
            client.send("cancel", runId=cancel_id)
            client.receive("cancelled")
            client.send(
                "host_result", runId=cancel_id, callId=call["callId"], result={"completed": True}
            )
            fail_id = f"{task}-failed"
            call = client.run(fail_id, task=task)
            client.send("host_error", runId=fail_id, callId=call["callId"], code="AGENT_HOST_ERROR")
            assert client.receive("error")["code"] == "AGENT_HOST_ERROR"
        for locale, language in (("zh-CN", "Simplified Chinese"), ("en", "English")):
            run_id = f"title-{locale}"
            call = client.run(
                run_id, task="conversation-title", content="/concept coffee", output_language=locale
            )
            assert call["operation"] == "model.title"
            assert f"Write the title in {language} ({locale})" in call["args"]["systemPrompt"]
            client.send(
                "host_result", runId=run_id, callId=call["callId"], result={"text": "Coffee"}
            )
            assert client.receive("result")["text"] == "Coffee"
        call = client.run("title-cancel", task="conversation-title")
        client.send("cancel", runId="title-cancel")
        client.receive("cancelled")
        client.send(
            "host_result", runId="title-cancel", callId=call["callId"], result={"text": "late"}
        )
        call = client.run("title-failed", task="conversation-title")
        client.send(
            "host_error", runId="title-failed", callId=call["callId"], code="AGENT_HOST_ERROR"
        )
        assert client.receive("error")["code"] == "AGENT_HOST_ERROR"
        for task, field in (("explore-phrase", "phrase"), ("explore-vocabulary", "term")):
            for locale, language in (("zh-CN", "Simplified Chinese"), ("en", "English")):
                run_id = f"{task}-{locale}"
                call = client.run(run_id, task=task, output_language=locale)
                assert call["operation"] == f"{task}.prepare"
                client.send(
                    "host_result",
                    runId=run_id,
                    callId=call["callId"],
                    result={"acceptedCount": 0, "inputChars": 1000},
                )
                for attempt, accepted in enumerate((4, 7, 10), 1):
                    call = client.receive("host_call")
                    assert call["operation"] == f"model.{task}"
                    assert call["args"]["attempt"] == attempt
                    assert language in call["args"]["systemPrompt"]
                    assert (
                        f"{field} and example are written in English"
                        in call["args"]["systemPrompt"]
                    )
                    client.send(
                        "host_result",
                        runId=run_id,
                        callId=call["callId"],
                        result={
                            "attempt": attempt,
                            "acceptedCount": accepted,
                            "inputChars": 0 if accepted == 10 else 1000,
                        },
                    )
                assert client.receive(task.replace("-", "_") + "_result")["result"] == {
                    "attempts": 3,
                    "acceptedCount": 10,
                }
            call = client.run(f"{task}-cancel", task=task)
            client.send(
                "host_result",
                runId=f"{task}-cancel",
                callId=call["callId"],
                result={"acceptedCount": 0, "inputChars": 1000},
            )
            call = client.receive("host_call")
            client.send("cancel", runId=f"{task}-cancel")
            client.receive("cancelled")
            client.send(
                "host_result",
                runId=f"{task}-cancel",
                callId=call["callId"],
                result={"attempt": 1, "acceptedCount": 10, "inputChars": 0},
            )
        for locale, language in (("zh-CN", "Simplified Chinese"), ("en", "English")):
            run_id = f"synonym-{locale}"
            call = client.run(run_id, task="synonym", output_language=locale)
            assert call["operation"] == "synonym.prepare"
            client.send(
                "host_result",
                runId=run_id,
                callId=call["callId"],
                result={"items": [{"inputIndex": i, "status": "pending"} for i in range(20)]},
            )
            for index in range(20):
                for round_ in (1, 2):
                    call = client.receive("host_call")
                    assert call["operation"] == "model.synonym"
                    assert call["args"]["inputIndex"] == index
                    assert call["args"]["round"] == round_
                    assert language in call["args"]["systemPrompt"]
                    client.send(
                        "host_result",
                        runId=run_id,
                        callId=call["callId"],
                        result={
                            "inputIndex": index,
                            "round": round_,
                            "kind": "tool",
                            "inputChars": 4000,
                        },
                    )
                    call = client.receive("host_call")
                    assert call["operation"] == "synonym.apply"
                    assert call["args"]["action"] == "execute"
                    client.send(
                        "host_result",
                        runId=run_id,
                        callId=call["callId"],
                        result={
                            "inputIndex": index,
                            "round": round_,
                            "kind": "continue" if round_ == 1 else "terminal",
                        },
                    )
                call = client.receive("host_call")
                assert call["operation"] == "synonym.finish"
                client.send(
                    "host_result",
                    runId=run_id,
                    callId=call["callId"],
                    result={"inputIndex": index, "stop": False},
                )
            assert client.receive("synonym_result")["result"] == {
                "completedIndices": list(range(20))
            }
        call = client.run("synonym-cancel", task="synonym")
        client.send(
            "host_result",
            runId="synonym-cancel",
            callId=call["callId"],
            result={"items": [{"inputIndex": 0, "status": "pending"}]},
        )
        call = client.receive("host_call")
        assert call["operation"] == "model.synonym"
        client.send("cancel", runId="synonym-cancel")
        client.receive("cancelled")
        client.send(
            "host_result",
            runId="synonym-cancel",
            callId=call["callId"],
            result={"inputIndex": 0, "round": 1, "kind": "tool", "inputChars": 4000},
        )
        call = client.run("stream")
        for seq, event in enumerate(
            [{"type": "reasoning", "delta": "temporary"}, {"type": "text", "delta": "你好"}], 1
        ):
            client.send("host_chunk", runId="stream", callId=call["callId"], seq=seq, event=event)
            assert client.receive("event")["event"] == event
        client.send("host_result", runId="stream", callId=call["callId"], result={"text": "你好"})
        assert client.receive("result")["text"] == "你好"
        for language, name in [("zh-CN", "Simplified Chinese (zh-CN)"), ("en", "English (en)")]:
            run_id = f"concept-{language}"
            call = client.run(run_id, content="/concept carry", output_language=language)
            assert call["operation"] == "model.reply"
            prompt = call["args"]["systemPrompt"]
            assert f"commentary on examples in {name}" in prompt
            assert "the example sentences themselves in English (en)" in prompt
            event = {"type": "text", "delta": "concept"}
            client.send("host_chunk", runId=run_id, callId=call["callId"], seq=1, event=event)
            assert client.receive("event")["event"] == event
            client.send(
                "host_result", runId=run_id, callId=call["callId"], result={"text": "concept"}
            )
            assert client.receive("result")["text"] == "concept"
        call = client.run("concept-failure", content="/concept carry")
        client.send(
            "host_error", runId="concept-failure", callId=call["callId"], code="AGENT_LIMIT"
        )
        assert client.receive("error")["code"] == "AGENT_LIMIT"
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
        call = client.run("cancel", content="/concept carry")
        client.send("cancel", runId="cancel")
        client.receive("cancelled")
        client.send("host_result", runId="cancel", callId=call["callId"], result={"text": "late"})
        client.run("crash", content="/concept carry")
        client.process.kill()
        client.process.wait(timeout=5)
    finally:
        if client.process.poll() is None:
            client.process.kill()
            client.process.wait(timeout=5)
    client = Client(cwd)
    try:
        restart_ms = client.start()
        call = client.run("concept-retry", content="/concept carry")
        client.send(
            "host_result", runId="concept-retry", callId=call["callId"], result={"text": "retried"}
        )
        assert client.receive("result")["text"] == "retried"
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
                "vocabulary-practice-languages-tool-loop-correction",
                "vocabulary-practice-cancel-late-result-failure",
                "sentence-practice-languages",
                "sentence-practice-cancel-late-result",
                "sentence-practice-failure",
                "title-languages",
                "title-cancel-late-result",
                "title-failure",
                "stream",
                "concept-languages-stream",
                "concept-failure",
                "concept-retry",
                "vocabulary-20-terms",
                "phrase-20-items",
                "synonym-languages-20-items-multi-turn",
                "explore-phrase-languages-top-up",
                "explore-phrase-cancel-late-result",
                "explore-vocabulary-languages-top-up",
                "explore-vocabulary-cancel-late-result",
                "synonym-cancel-late-result",
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
