"""Untrusted child exercising exploration boundaries; never handles learning data."""
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


def model(index, attempt):
    call(index, "model.explore-vocabulary", {"attempt": attempt, "systemPrompt": "Explain in English."})


if mode == "cross-run":
    call(0, "explore-vocabulary.prepare", {}, owner="other-run")
elif mode == "cross-call":
    call(0, "explore-vocabulary.prepare", {}, call_id="other-run:call")
elif mode == "before-prepare":
    model(0, 1)
else:
    call(0, "explore-vocabulary.prepare", {})
    json.loads(sys.stdin.readline())
    if mode == "premature-result":
        send("explore_vocabulary_result", runId=run_id, result={"attempts": 1, "acceptedCount": 10})
    elif mode == "forbidden-operation":
        call(1, "model.reply", {"systemPrompt": "Explain in English."})
    elif mode == "wrong-result":
        send("phrase_result", runId=run_id, result={"completedIndices": []})
    elif mode == "phrase-operation":
        call(1, "explore-phrase.prepare", {})
    elif mode == "phrase-completion":
        send("explore_phrase_result", runId=run_id, result={"attempts": 1, "acceptedCount": 10})
    elif mode == "duplicate-prepare":
        call(1, "explore-vocabulary.prepare", {})
    elif mode == "skipped-attempt":
        model(1, 2)
    elif mode == "excess-concurrency":
        model(1, 1)
        model(2, 2)
    else:
        model(1, 1)
        json.loads(sys.stdin.readline())
        if mode == "duplicate-attempt":
            model(2, 1)
        elif mode == "forged-count":
            send("explore_vocabulary_result", runId=run_id, result={"attempts": 1, "acceptedCount": 10})
        elif mode == "partial-result":
            send("explore_vocabulary_result", runId=run_id, result={"attempts": 1, "acceptedCount": 4})

for line in sys.stdin:
    frame = json.loads(line)
    if frame["type"] == "cancel":
        send("cancelled", runId=frame["runId"])
    elif frame["type"] == "shutdown":
        send("shutdown_ack")
        break
