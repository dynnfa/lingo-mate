from lingo_agent.workflows.conversation.graph import execute_conversation as execute


def conversation_snapshot():
    return {
        "task": "conversation",
        "messages": [{"role": "user", "content": "word"}],
        "outputLanguage": "zh-CN",
        "targetLanguage": "en",
        "allowedOperations": ["model.reply"],
        "budget": {
            "timeoutMs": 1000,
            "maxModelCalls": 1,
            "maxToolCalls": 1,
            "maxSteps": 6,
            "maxInputChars": 8192,
            "maxOutputChars": 100,
        },
    }


async def test_reply_budget_counts_actual_prompt_instead_of_reserved_space():
    snapshot = conversation_snapshot()
    snapshot["budget"]["maxInputChars"] = 4096
    snapshot["messages"] = [{"role": "user", "content": "x" * 3500}]
    calls = []

    async def host(operation, args):
        calls.append((operation, args))
        return {"text": "answer"}

    state = await execute("actual-input", snapshot, host)
    assert state["text"] == "answer"
    assert len(calls) == 1


async def test_prompt_budget_rejects_oversize_unicode_input_before_host_call():
    import pytest

    from lingo_agent.workflows.common import LimitError

    snapshot = conversation_snapshot()
    snapshot["budget"]["maxInputChars"] = 4096
    snapshot["messages"] = [{"role": "user", "content": "😀" * 2040}]
    calls = []

    async def host(operation, args):
        calls.append(operation)
        return {"text": "answer"}

    with pytest.raises(LimitError):
        await execute("unicode-overflow", snapshot, host)
    assert calls == []
