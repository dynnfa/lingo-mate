"""Untrusted engine used to verify sentence translation ownership and ordering."""
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
    call(index, operation, {"systemPrompt": "Explain in English."})


if mode == "cross-run":
    call(0, "sentence.prepare", {}, owner="other-run")
elif mode == "cross-call":
    call(0, "sentence.prepare", {}, call_id="other-run:call")
elif mode == "before-prepare":
    model(0)
else:
    call(0, "sentence.prepare", {})
    json.loads(sys.stdin.readline())
    if mode == "premature-result":
        send("sentence_result", runId=run_id, result={"completed": True})
    elif mode == "forbidden-operation":
        call(1, "model.reply", {"systemPrompt": "Explain in English."})
    elif mode == "cross-task":
        other = "review" if operation.endswith("hints") else "hints"
        call(1, f"model.sentence-practice-{other}", {"systemPrompt": "Explain in English."})
    elif mode == "wrong-result":
        send("result", runId=run_id, text="forged")
    elif mode == "duplicate-prepare":
        call(1, "sentence.prepare", {})
    elif mode == "oversized-prompt":
        call(1, operation, {"systemPrompt": "😀" * 2049})
    elif mode == "extra-authority":
        call(1, operation, {"systemPrompt": "Explain in English.", "answer": "forged"})
    else:
        model(1)
        if mode == "excess-concurrency":
            model(2)
        else:
            json.loads(sys.stdin.readline())
            if mode == "duplicate-model":
                model(2)
            elif mode == "engine-failure":
                send("error", runId=run_id, code="AGENT_HOST_ERROR")

for line in sys.stdin:
    frame = json.loads(line)
    if frame["type"] == "cancel":
        send("cancelled", runId=frame["runId"])
    elif frame["type"] == "shutdown":
        send("shutdown_ack")
        break
