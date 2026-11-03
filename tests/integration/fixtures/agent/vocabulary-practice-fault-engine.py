"""Untrusted engine used to verify vocabulary practice ownership and ordering."""
import json
import sys

mode = sys.argv[1]
hello = json.loads(sys.stdin.readline())
base = {"v": 12, "instanceId": hello["instanceId"]}


def send(kind, **payload):
    print(json.dumps({**base, "type": kind, **payload}), flush=True)


send("ready", capabilities=["sentence", "tts", "conversation", "conversation-title", "tool-loop", "vocabulary", "phrase", "synonym", "explore-phrase", "explore-vocabulary", "sentence-practice-hints", "sentence-practice-review", "vocabulary-practice-review"])
run = json.loads(sys.stdin.readline())
run_id = run["runId"]
operation = f"model.{run['snapshot']['task']}"


def call(index, op, args, owner=run_id, call_id=None):
    send("host_call", runId=owner, callId=call_id or f"{run_id}:{index}", operation=op, args=args)


def model(index):
    call(index, operation, {"systemPrompt": "Explain in English.", "round": 1})


if mode == "cross-run":
    call(0, "vocabulary-practice.prepare", {}, owner="other-run")
elif mode == "cross-call":
    call(0, "vocabulary-practice.prepare", {}, call_id="other-run:call")
elif mode == "before-prepare":
    model(0)
else:
    call(0, "vocabulary-practice.prepare", {})
    json.loads(sys.stdin.readline())
    if mode == "premature-result":
        send("vocabulary_practice_result", runId=run_id, result={"completed": True, "rounds": 1})
    elif mode == "forbidden-operation":
        call(1, "model.reply", {"systemPrompt": "Explain in English.", "round": 1})
    elif mode == "cross-task":
        call(1, "model.sentence-practice-review", {"systemPrompt": "Explain in English."})
    elif mode == "wrong-round":
        call(1, operation, {"systemPrompt": "Explain in English.", "round": 2})
    elif mode == "apply-before-model":
        call(1, "vocabulary-practice.apply", {"round": 1})
    elif mode == "wrong-result":
        send("result", runId=run_id, text="forged")
    elif mode == "duplicate-prepare":
        call(1, "vocabulary-practice.prepare", {})
    elif mode == "oversized-prompt":
        call(1, operation, {"systemPrompt": "😀" * 2049, "round": 1})
    elif mode == "extra-authority":
        call(1, operation, {"systemPrompt": "Explain in English.", "round": 1, "answer": "forged", "round": 1})
    else:
        model(1)
        if mode == "excess-concurrency":
            model(2)
        else:
            json.loads(sys.stdin.readline())
            if mode == "duplicate-model":
                model(2)
            elif mode == "forged-complete-after-model":
                send("vocabulary_practice_result", runId=run_id, result={"completed": True, "rounds": 1})
            elif mode == "engine-failure":
                send("error", runId=run_id, code="AGENT_HOST_ERROR")

for line in sys.stdin:
    frame = json.loads(line)
    if frame["type"] == "cancel":
        send("cancelled", runId=frame["runId"])
    elif frame["type"] == "shutdown":
        send("shutdown_ack")
        break
