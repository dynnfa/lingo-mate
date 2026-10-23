"""Untrusted child used to exercise synonym protocol boundaries."""

import json
import sys

mode = sys.argv[1]
hello = json.loads(sys.stdin.readline())
base = {"v": 7, "instanceId": hello["instanceId"]}


def send(kind, **payload):
    print(json.dumps({**base, "type": kind, **payload}), flush=True)


send("ready", capabilities=["conversation", "tool-loop", "vocabulary", "phrase", "synonym", "explore-phrase", "explore-vocabulary"])
run = json.loads(sys.stdin.readline())
run_id = run["runId"]


def call(index, operation, args, owner=run_id, call_id=None):
    send("host_call", runId=owner, callId=call_id or f"{run_id}:{index}", operation=operation, args=args)


if mode == "cross-run":
    call(0, "synonym.prepare", {}, owner="other-run")
elif mode == "cross-call":
    call(0, "synonym.prepare", {}, call_id="other-run:call")
else:
    call(0, "synonym.prepare", {})
    json.loads(sys.stdin.readline())
    if mode == "premature-result":
        send("synonym_result", runId=run_id, result={"completedIndices": []})
    elif mode == "forbidden-operation":
        call(1, "model.reply", {"systemPrompt": "Explain in English."})
    elif mode == "wrong-result":
        send("vocabulary_result", runId=run_id, result={"completedIndices": []})
    elif mode == "vocabulary-operation":
        call(1, "model.vocabulary", {"inputIndex": 0, "systemPrompt": "Explain in English."})
    elif mode == "invalid-index":
        call(1, "model.synonym", {"inputIndex": 19, "systemPrompt": "Explain in English.", "round": 1})
    elif mode == "duplicate-index":
        call(1, "model.synonym", {"inputIndex": 0, "systemPrompt": "Explain in English.", "round": 1})
        json.loads(sys.stdin.readline())
        call(2, "model.synonym", {"inputIndex": 0, "systemPrompt": "Explain in English.", "round": 1})
    elif mode == "apply-without-model":
        call(1, "synonym.apply", {"inputIndex": 0, "round": 1, "action": "execute"})
    elif mode == "finish-without-model":
        call(1, "synonym.finish", {"inputIndex": 0, "round": 1, "reason": "terminal"})
    elif mode == "wrong-round":
        call(1, "model.synonym", {"inputIndex": 0, "round": 2, "systemPrompt": "English"})
    elif mode == "out-of-order":
        call(1, "model.synonym", {"inputIndex": 1, "round": 1, "systemPrompt": "English"})
    elif mode == "excess-concurrency":
        for index in range(3):
            call(index + 1, "model.synonym", {"inputIndex": index, "systemPrompt": "Explain in English.", "round": 1})

# Acknowledge cancellation so tests exercise the targeted error, not the grace timeout.
for line in sys.stdin:
    frame = json.loads(line)
    if frame["type"] == "cancel":
        send("cancelled", runId=frame["runId"])
    elif frame["type"] == "shutdown":
        send("shutdown_ack")
        break
