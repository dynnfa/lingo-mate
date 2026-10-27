import pytest

from lingo_agent.runtime.dispatcher import execute
from lingo_agent.workflows.conversation.routing import is_word_concept_message


@pytest.mark.parametrize(
    "text",
    [
        "/concept",
        "/concept pursue",
        "/concept\tbank",
        "/concept　bank",
        " /concept pursue ",
        "\t /concept　bank \n",
        "\ufeff/concept\ufeffbank",
    ],
)
def test_command_recognizes_ecmascript_whitespace(text):
    assert is_word_concept_message(text)


@pytest.mark.parametrize(
    "text",
    [
        "/conceptual drift",
        "What does /concept mean?",
        "/Concept pursue",
        "pursue",
        "",
        "\u0085/concept bank",
        "/concept\u0085bank",
        "\u001c/concept bank",
    ],
)
def test_command_ignores_embedded_text_prefixes_and_python_only_whitespace(text):
    assert not is_word_concept_message(text)


@pytest.mark.parametrize(
    "messages, concept",
    [
        ([{"role": "user", "content": "/concept carry"}], True),
        (
            [
                {"role": "user", "content": "/concept carry"},
                {"role": "assistant", "content": "answer"},
                {"role": "user", "content": "another example"},
            ],
            False,
        ),
        ([{"role": "assistant", "content": "/concept carry"}], False),
        ([{"role": "user", "content": "/conceptual drift"}], False),
    ],
)
async def test_only_the_last_user_message_selects_concept_instructions(messages, concept):
    prompts = []

    async def host(operation, args):
        assert operation == "model.reply"
        prompts.append(args["systemPrompt"])
        return {"text": "answer"}

    await execute(
        "routing",
        {
            "task": "conversation",
            "messages": messages,
            "outputLanguage": "en",
            "targetLanguage": "en",
            "allowedOperations": ["model.reply"],
            "budget": {
                "maxInputChars": 8192,
                "maxOutputChars": 100,
                "maxSteps": 4,
                "maxModelCalls": 1,
            },
        },
        host,
    )
    assert ("the /concept command" in prompts[0]) == concept


def snapshot(content="/concept carry", output="zh-CN", target="en"):
    return {
        "task": "conversation",
        "messages": [{"role": "user", "content": content}],
        "outputLanguage": output,
        "targetLanguage": target,
        "allowedOperations": ["model.reply"],
        "budget": {
            "timeoutMs": 1000,
            "maxModelCalls": 1,
            "maxToolCalls": 0,
            "maxSteps": 4,
            "maxInputChars": 8192,
            "maxOutputChars": 100,
        },
    }


@pytest.mark.parametrize(
    "content,role,concept",
    [
        ("/concept carry", "user", True),
        ("/concept", "user", True),
        (" \t/concept\u3000bank \n", "user", True),
        ("\ufeff/concept\ufeffbank", "user", True),
        ("/conceptual drift", "user", False),
        ("What does /concept mean?", "user", False),
        ("/Concept carry", "user", False),
        ("/concept\u0085bank", "user", False),
        ("/concept carry", "assistant", False),
        ("another example", "user", False),
    ],
)
async def test_entry_routes_only_latest_user_command(content, role, concept):
    request = snapshot(content)
    request["messages"] = [
        {"role": "user", "content": "/concept bank"},
        {"role": "assistant", "content": "previous explanation"},
        {"role": role, "content": content},
    ]
    calls = []

    async def host(operation, args):
        calls.append(operation)
        return {"text": "answer"}

    state = await execute("routing", request, host)
    assert state["step"] == ("explain" if concept else "reply")
    assert calls == ["model.reply"]


async def test_routes_concept_through_host_and_preserves_languages():
    calls = []
    snapshot = {
        "task": "conversation",
        "messages": [{"role": "user", "content": "/concept carry"}],
        "outputLanguage": "zh-CN",
        "targetLanguage": "en",
        "allowedOperations": ["model.reply"],
        "budget": {
            "timeoutMs": 1000,
            "maxModelCalls": 1,
            "maxToolCalls": 0,
            "maxSteps": 4,
            "maxInputChars": 8192,
            "maxOutputChars": 100,
        },
    }

    async def host(operation, args):
        calls.append((operation, args))
        return {"text": "answer"}

    state = await execute("run-1", snapshot, host)
    assert len(calls) == 1
    assert calls[0][0] == "model.reply"
    prompt = calls[0][1]["systemPrompt"]
    assert "the /concept command" in prompt
    assert "commentary on examples in Simplified Chinese (zh-CN)" in prompt
    assert "the example sentences themselves in English (en)" in prompt
    assert state["text"] == "answer"
    assert state["languages"] == {"outputLanguage": "zh-CN", "targetLanguage": "en"}
    assert state["status"] == "completed"
