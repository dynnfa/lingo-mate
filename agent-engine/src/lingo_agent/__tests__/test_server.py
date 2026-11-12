import json
import subprocess
import sys

from lingo_agent.runtime.server import Server


async def test_unknown_internal_task_becomes_protocol_error_without_host_call(monkeypatch):
    server = Server()
    frames = []
    calls = []

    async def send(kind, **payload):
        frames.append((kind, payload))

    async def host(run_id, operation, args):
        calls.append(operation)
        raise AssertionError("unknown task must not reach the host")

    monkeypatch.setattr(server, "send", send)
    monkeypatch.setattr(server, "host", host)
    await server.run(
        "unknown",
        {
            "task": "unknown",
            "messages": [{"role": "user", "content": "hello"}],
            "outputLanguage": "en",
            "targetLanguage": "en",
            "allowedOperations": ["model.reply"],
            "budget": {
                "timeoutMs": 1000,
                "maxInputChars": 8192,
                "maxOutputChars": 100,
                "maxModelCalls": 1,
                "maxSteps": 1,
            },
        },
    )
    assert frames == [("error", {"runId": "unknown", "code": "AGENT_PROTOCOL_ERROR"})]
    assert calls == []
    assert not server.runs and not server.calls
    assert "unknown" in server.retired


def test_shutdown_exits_cleanly_with_the_parent_input_pipe_still_open():
    child = subprocess.Popen(
        [sys.executable, "-I", "-m", "lingo_agent"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        for kind in ["hello", "shutdown"]:
            child.stdin.write(
                (json.dumps({"v": 13, "instanceId": "shutdown-test", "type": kind}) + "\n").encode()
            )
            child.stdin.flush()
            assert json.loads(child.stdout.readline())["type"] == (
                "ready" if kind == "hello" else "shutdown_ack"
            )
        assert child.wait(timeout=5) == 0
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
        child.stdin.close()
        child.stdout.close()
        child.stderr.close()
