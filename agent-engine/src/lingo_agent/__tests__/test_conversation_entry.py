from typing import Any

import pytest

from lingo_agent.runtime.dispatcher import execute


def snapshot(command: str | None, has_arguments: bool, mode: str = "desktop") -> dict[str, Any]:
    return {
        "task": "conversation-route",
        "inputChars": 20,
        "route": {"mode": mode, "command": command, "hasArguments": has_arguments},
        "outputLanguage": "zh-CN",
        "targetLanguage": "en",
        "allowedOperations": ["model.classify-conversation"],
        "budget": {
            "timeoutMs": 15_000,
            "maxModelCalls": 1,
            "maxToolCalls": 0,
            "maxSteps": 1,
            "maxInputChars": 8096,
            "maxOutputChars": 256,
        },
    }


@pytest.mark.parametrize(
    "command,has_arguments,mode,expected",
    [
        ("concept", False, "desktop", {"kind": "workflow", "workflow": "concept"}),
        ("vocabulary", True, "desktop", {"kind": "workflow", "workflow": "vocabulary"}),
        ("phrase", True, "desktop", {"kind": "workflow", "workflow": "phrase"}),
        ("synonym", True, "desktop", {"kind": "workflow", "workflow": "synonym"}),
        ("sentence", True, "desktop", {"kind": "workflow", "workflow": "sentence"}),
        ("tts", True, "desktop", {"kind": "workflow", "workflow": "tts"}),
        ("explore-phrase", False, "desktop", {"kind": "workflow", "workflow": "explore-phrase"}),
        (
            "explore-vocabulary",
            False,
            "desktop",
            {"kind": "workflow", "workflow": "explore-vocabulary"},
        ),
        ("sentence", False, "desktop", {"kind": "invalid", "workflow": "sentence"}),
        ("explore-phrase", True, "desktop", {"kind": "invalid", "workflow": "explore-phrase"}),
        ("sentence-extra", True, "desktop", {"kind": "reply"}),
        ("unknown", True, "desktop", {"kind": "reply"}),
        ("Concept", True, "desktop", {"kind": "reply"}),
        ("tts", True, "channel-chat", {"kind": "reply"}),
        ("concept", True, "channel-chat", {"kind": "reply"}),
        ("sentence", True, "channel-sentence", {"kind": "workflow", "workflow": "sentence"}),
        ("tts", True, "channel-sentence", {"kind": "reply"}),
        ("sentence", True, "retry", {"kind": "reply"}),
        ("concept", True, "retry", {"kind": "workflow", "workflow": "concept"}),
    ],
)
async def test_deterministic_routes_do_not_call_model(command, has_arguments, mode, expected):
    async def host(operation, args):
        pytest.fail(f"Unexpected host operation {operation}")

    state = await execute("entry", snapshot(command, has_arguments, mode), host)
    assert state["route"] == expected


@pytest.mark.parametrize(
    "intent,expected",
    [
        ("concept", {"kind": "workflow", "workflow": "concept"}),
        ("reply", {"kind": "reply"}),
        ("unclear", {"kind": "reply"}),
    ],
)
async def test_natural_language_classifies_once(intent, expected):
    calls = []

    async def host(operation, args):
        calls.append(operation)
        assert "Simplified Chinese (zh-CN)" in args["systemPrompt"]
        assert "English (en)" in args["systemPrompt"]
        return {"intent": intent}

    state = await execute("entry", snapshot(None, False), host)
    assert calls == ["model.classify-conversation"]
    assert state["route"] == expected
