"""Deliberately broken child process; never used by application code."""

import json
import sys
import time

mode = sys.argv[1]
hello = json.loads(sys.stdin.readline())
base = {"v": 11, "instanceId": hello["instanceId"]}
if mode == "wrong-version":
    base["v"] = 99
if mode == "wrong-instance":
    base["instanceId"] = "other-process"
if mode == "truncated":
    sys.stdout.write('{"v":2')
    sys.stdout.flush()
    raise SystemExit(0)
print(
    json.dumps(
        {**base, "type": "ready", "capabilities": ["tts", "conversation", "conversation-title", "tool-loop", "vocabulary", "phrase", "synonym", "explore-phrase", "explore-vocabulary", "sentence-practice-hints", "sentence-practice-review", "vocabulary-practice-review"]}
    ),
    flush=True,
)
if mode in ("unknown-run", "duplicate-call"):
    frame = json.loads(sys.stdin.readline())
    call = {
        **base,
        "type": "host_call",
        "runId": frame["runId"] if mode == "duplicate-call" else "forged-run",
        "callId": frame["runId"] + ":call",
        "operation": "model.reply",
        "args": {"systemPrompt": "Reply in English."},
    }
    print(json.dumps(call), flush=True)
    if mode == "duplicate-call":
        print(json.dumps(call), flush=True)
    time.sleep(60)
if mode == "ignore-cancel":
    sys.stdin.readline()
    time.sleep(60)
