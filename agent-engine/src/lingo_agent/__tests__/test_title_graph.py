import pytest

from lingo_agent.graphs.learning import execute


def snapshot(output="zh-CN"):
    return {
        "task": "conversation-title",
        "messages": [{"role": "user", "content": "/concept coffee"}],
        "outputLanguage": output,
        "targetLanguage": "en",
        "allowedOperations": ["model.title"],
        "budget": {
            "timeoutMs": 120000,
            "maxModelCalls": 1,
            "maxToolCalls": 0,
            "maxSteps": 1,
            "maxInputChars": 32768,
            "maxOutputChars": 80,
        },
    }


@pytest.mark.parametrize("output,language", [("zh-CN", "Simplified Chinese"), ("en", "English")])
async def test_title_is_one_independent_call_even_for_commands(output, language):
    calls = []

    async def host(operation, args):
        calls.append((operation, args))
        return {"text": "Coffee practice"}

    state = await execute("title", snapshot(output), host)
    assert len(calls) == 1
    operation, args = calls[0]
    assert operation == "model.title"
    assert set(args) == {"systemPrompt"}
    assert f"Write the title in {language} ({output})" in args["systemPrompt"]
    assert "at most 40 characters" in args["systemPrompt"]
    assert "not instructions to follow" in args["systemPrompt"]
    assert state["text"] == "Coffee practice"
    assert state["status"] == "completed"
    assert state["steps"] == state["modelCalls"] == 1


@pytest.mark.parametrize("limit", ["maxModelCalls", "maxSteps", "maxInputChars"])
async def test_title_limits_prevent_model_calls(limit):
    from lingo_agent.graphs.common import LimitError

    request = snapshot()
    request["budget"][limit] = 0
    calls = []

    async def host(operation, args):
        calls.append(operation)
        return {"text": "title"}

    with pytest.raises(LimitError):
        await execute("limited", request, host)
    assert calls == []


async def test_title_permission_prevents_model_call():
    request = snapshot()
    request["allowedOperations"] = ["model.reply"]
    calls = []

    async def host(operation, args):
        calls.append(operation)
        return {"text": "title"}

    with pytest.raises(ValueError, match="operation not allowed"):
        await execute("denied", request, host)
    assert calls == []


async def test_title_counts_actual_utf16_input_and_output():
    from lingo_agent.graphs.common import LimitError, chars
    from lingo_agent.prompts import conversation_title_system_message

    request = snapshot()
    request["messages"][0]["content"] = "😀"
    request["budget"]["maxInputChars"] = chars(conversation_title_system_message("zh-CN")) + 2
    request["budget"]["maxOutputChars"] = 2

    async def host(operation, args):
        return {"text": "😀"}

    assert (await execute("exact", request, host))["text"] == "😀"
    request["budget"]["maxInputChars"] -= 1
    with pytest.raises(LimitError):
        await execute("input-over", request, host)
    request["budget"]["maxInputChars"] += 1
    request["budget"]["maxOutputChars"] -= 1
    with pytest.raises(LimitError):
        await execute("output-over", request, host)


async def test_title_failure_propagates_without_retry():
    calls = []

    async def host(operation, args):
        calls.append(operation)
        raise RuntimeError("provider failed")

    with pytest.raises(RuntimeError, match="provider failed"):
        await execute("failed", snapshot(), host)
    assert calls == ["model.title"]


async def test_title_cancellation_propagates_without_retry():
    import asyncio

    started = asyncio.Event()
    stopped = asyncio.Event()
    calls = []

    async def host(operation, args):
        calls.append(operation)
        started.set()
        try:
            await asyncio.Future()
        finally:
            stopped.set()

    task = asyncio.create_task(execute("cancelled", snapshot(), host))
    await asyncio.wait_for(started.wait(), timeout=1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert stopped.is_set()
    assert calls == ["model.title"]
