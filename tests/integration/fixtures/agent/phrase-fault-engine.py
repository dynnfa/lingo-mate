"""Untrusted child used to exercise phrase protocol boundaries."""

import json
import sys

mode = sys.argv[1]
hello = json.loads(sys.stdin.readline())
base = {"v": 9, "instanceId": hello["instanceId"]}


def send(kind, **payload):
    print(json.dumps({**base, "type": kind, **payload}), flush=True)


send("ready", capabilities=["conversation", "conversation-title", "tool-loop", "vocabulary", "phrase", "synonym", "explore-phrase", "explore-vocabulary", "sentence-practice-hints", "sentence-practice-review"])
run = json.loads(sys.stdin.readline())
run_id = run["runId"]


def call(index, operation, args, owner=run_id, call_id=None):
    send("host_call", runId=owner, callId=call_id or f"{run_id}:{index}", operation=operation, args=args)


if mode == "cross-run":
    call(0, "phrase.prepare", {}, owner="other-run")
elif mode == "cross-call":
    call(0, "phrase.prepare", {}, call_id="other-run:call")
else:
    call(0, "phrase.prepare", {})
    json.loads(sys.stdin.readline())
    if mode == "premature-result":
        send("phrase_result", runId=run_id, result={"completedIndices": []})
    elif mode == "forbidden-operation":
        call(1, "model.reply", {"systemPrompt": "Explain in English."})
    elif mode == "wrong-result":
        send("vocabulary_result", runId=run_id, result={"completedIndices": []})
    elif mode == "vocabulary-operation":
        call(1, "model.vocabulary", {"inputIndex": 0, "systemPrompt": "Explain in English."})
    elif mode == "invalid-index":
        call(1, "model.phrase", {"inputIndex": 19, "systemPrompt": "Explain in English."})
    elif mode == "duplicate-index":
        call(1, "model.phrase", {"inputIndex": 0, "systemPrompt": "Explain in English."})
        json.loads(sys.stdin.readline())
        call(2, "model.phrase", {"inputIndex": 0, "systemPrompt": "Explain in English."})
    elif mode == "excess-concurrency":
        for index in range(3):
            call(index + 1, "model.phrase", {"inputIndex": index, "systemPrompt": "Explain in English."})

# Acknowledge cancellation so tests exercise the targeted error, not the grace timeout.
for line in sys.stdin:
    frame = json.loads(line)
    if frame["type"] == "cancel":
        send("cancelled", runId=frame["runId"])
    elif frame["type"] == "shutdown":
        send("shutdown_ack")
        break
