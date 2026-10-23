import json
import subprocess
import sys


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
                (json.dumps({"v": 8, "instanceId": "shutdown-test", "type": kind}) + "\n").encode()
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
