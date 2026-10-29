"""Deliberately broken TTS engine; test-only."""

import json
import sys

mode = sys.argv[1]
hello = json.loads(sys.stdin.readline())
base = {"v": 12, "instanceId": hello["instanceId"]}


def send(kind, **data):
    print(json.dumps({**base, "type": kind, **data}), flush=True)


send("ready", capabilities=["sentence", "tts", "conversation", "conversation-title", "tool-loop", "vocabulary", "phrase", "synonym", "explore-phrase", "explore-vocabulary", "sentence-practice-hints", "sentence-practice-review", "vocabulary-practice-review"])
run = json.loads(sys.stdin.readline())["runId"]
if mode == "premature":
    send("tts_result", runId=run, result={"completed": True})
elif mode == "model":
    send("host_call", runId=run, callId=run + ":1", operation="model.reply", args={"systemPrompt": "Reply in English."})
elif mode == "wrong-result":
    send("host_call", runId=run, callId=run + ":1", operation="tts.synthesize", args={})
    json.loads(sys.stdin.readline())
    send("result", runId=run, text="")
elif mode == "override":
    send("host_call", runId=run, callId=run + ":1", operation="tts.synthesize", args={"text": "unbound"})
elif mode == "cross-run":
    send("host_call", runId="other-run", callId=run + ":1", operation="tts.synthesize", args={})
else:
    send("error", runId=run, code="AGENT_PROTOCOL_ERROR")
for line in sys.stdin:
    frame = json.loads(line)
    if frame["type"] == "cancel":
        send("cancelled", runId=frame["runId"])
    if frame["type"] == "shutdown":
        send("shutdown_ack")
        break
