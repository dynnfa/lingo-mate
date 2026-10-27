import asyncio

import pytest

from lingo_agent.workflows.common import LimitError
from lingo_agent.workflows.conversation.concept import execute_concept
from lingo_agent.workflows.conversation.graph import execute_conversation
from lingo_agent.workflows.conversation.prompts import (
    conversation_system_message,
    word_concept_system_message,
)


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


@pytest.mark.parametrize("output", ["zh-CN", "en"])
async def test_concept_graph_completes_once_with_original_context_and_prompt(output):
    request = snapshot(output=output, target="ja")
    request["messages"].insert(0, {"role": "assistant", "content": "Earlier context"})
    calls = []

    async def host(operation, args):
        calls.append((operation, args))
        return {"text": "explanation"}

    state = await execute_concept("concept-run", request, host)
    assert calls == [("model.reply", {"systemPrompt": word_concept_system_message(output, "ja")})]
    assert state["text"] == "explanation"
    assert state["status"] == "completed"
    assert state["step"] == "explain"
    assert state["runId"] == "concept-run"
    assert state["task"] == "conversation"
    assert state["messages"] == request["messages"]
    assert state["languages"] == {"outputLanguage": output, "targetLanguage": "ja"}
    assert state["modelCalls"] == state["steps"] == 1
    assert state["toolCount"] == 0


@pytest.mark.parametrize(
    "execute_graph,content", [(execute_concept, "/concept carry"), (execute_conversation, "Hello")]
)
@pytest.mark.parametrize("limit", ["maxModelCalls", "maxSteps", "maxInputChars"])
async def test_reply_limits_reject_before_host_call(execute_graph, content, limit):
    request = snapshot(content)
    request["budget"][limit] = 0
    calls = []

    async def host(operation, args):
        calls.append(operation)
        return {"text": "answer"}

    with pytest.raises(LimitError):
        await execute_graph("limited", request, host)
    assert calls == []


@pytest.mark.parametrize(
    "execute_graph,content", [(execute_concept, "/concept carry"), (execute_conversation, "Hello")]
)
async def test_reply_rejects_unauthorized_operation(execute_graph, content):
    request = snapshot(content)
    request["allowedOperations"] = []
    calls = []

    async def host(operation, args):
        calls.append(operation)
        return {"text": "answer"}

    with pytest.raises(ValueError, match="operation not allowed"):
        await execute_graph("unauthorized", request, host)
    assert calls == []


@pytest.mark.parametrize(
    "execute_graph,content", [(execute_concept, "/concept carry"), (execute_conversation, "Hello")]
)
async def test_one_step_budget_allows_exactly_one_reply(execute_graph, content):
    request = snapshot(content)
    request["budget"]["maxSteps"] = 1

    async def host(operation, args):
        return {"text": "answer"}

    state = await execute_graph("one-step", request, host)
    assert state["steps"] == state["modelCalls"] == 1
    assert state["status"] == "completed"


@pytest.mark.parametrize(
    "execute_graph,content", [(execute_concept, "/concept carry"), (execute_conversation, "Hello")]
)
async def test_reply_counts_actual_input_and_output_in_utf16_units(execute_graph, content):
    request = snapshot(content)
    prompt = (
        word_concept_system_message
        if content.startswith("/concept")
        else conversation_system_message
    )("zh-CN", "en")
    request["messages"].insert(0, {"role": "user", "content": "😀"})
    request["budget"]["maxInputChars"] = len(prompt) + len(content) + 2
    request["budget"]["maxOutputChars"] = 2
    calls = []

    async def host(operation, args):
        calls.append(operation)
        return {"text": "😀"}

    assert (await execute_graph("exact-limit", request, host))["text"] == "😀"
    request["budget"]["maxInputChars"] -= 1
    with pytest.raises(LimitError):
        await execute_graph("input-overflow", request, host)
    assert len(calls) == 1
    request["budget"]["maxInputChars"] += 1
    request["budget"]["maxOutputChars"] = 1
    with pytest.raises(LimitError):
        await execute_graph("output-overflow", request, host)
    assert len(calls) == 2


@pytest.mark.parametrize(
    "execute_graph,content", [(execute_concept, "/concept carry"), (execute_conversation, "Hello")]
)
async def test_reply_rejects_prompt_over_4096_utf16_units(execute_graph, content):
    request = snapshot(content, target="😀" * 2048)
    request["budget"]["maxInputChars"] = 32768
    calls = []

    async def host(operation, args):
        calls.append(operation)
        return {"text": "answer"}

    with pytest.raises(LimitError):
        await execute_graph("prompt-overflow", request, host)
    assert calls == []


async def test_concept_cancel_propagates_without_retry_or_completion():
    started = asyncio.Event()
    cancelled = asyncio.Event()
    calls = []

    async def host(operation, args):
        calls.append(operation)
        started.set()
        try:
            await asyncio.Future()
        finally:
            cancelled.set()

    task = asyncio.create_task(execute_concept("cancel", snapshot(), host))
    await asyncio.wait_for(started.wait(), timeout=1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert cancelled.is_set()
    assert calls == ["model.reply"]


async def test_concept_host_failure_propagates_without_retry():
    calls = []

    async def host(operation, args):
        calls.append(operation)
        raise RuntimeError("model failed")

    with pytest.raises(RuntimeError, match="model failed"):
        await execute_concept("failure", snapshot(), host)
    assert calls == ["model.reply"]
