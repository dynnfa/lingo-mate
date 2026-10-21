from lingo_agent.graphs.learning import execute


async def test_routes_concept_through_host_and_preserves_languages():
    calls = []
    snapshot = {
        "task": "word-concept",
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
    assert calls == [("model.reply", {})]
    assert state["text"] == "answer"
    assert state["languages"] == {"outputLanguage": "zh-CN", "targetLanguage": "en"}
    assert state["status"] == "completed"


async def test_model_tool_model_loop_is_bounded_and_correlated():
    snapshot = {
        "task": "tool-loop",
        "messages": [{"role": "user", "content": "word"}],
        "outputLanguage": "zh-CN",
        "targetLanguage": "en",
        "allowedOperations": ["model.decide", "learning.lookup"],
        "budget": {
            "timeoutMs": 1000,
            "maxModelCalls": 2,
            "maxToolCalls": 1,
            "maxSteps": 6,
            "maxInputChars": 8192,
            "maxOutputChars": 100,
        },
    }
    calls = []

    async def host(operation, args):
        calls.append((operation, args))
        if operation == "learning.lookup":
            return {"entries": ["carry: transport"]}
        if len(calls) == 1:
            return {"kind": "tool", "name": "learning.lookup", "query": "carry"}
        assert args == {"results": [{"entries": ["carry: transport"]}]}
        return {"kind": "final", "text": "explanation"}

    state = await execute("run-2", snapshot, host)
    assert [call[0] for call in calls] == ["model.decide", "learning.lookup", "model.decide"]
    assert state["text"] == "explanation"
    assert state["toolCalls"][0]["query"] == "carry"
    assert state["toolResults"] == [{"entries": ["carry: transport"]}]


async def test_unknown_tool_is_rejected_before_dispatch():
    import pytest

    snapshot = tool_snapshot()
    calls = []

    async def host(operation, args):
        calls.append(operation)
        return {"kind": "tool", "name": "arbitrary-sql", "query": "carry"}

    with pytest.raises(ValueError):
        await execute("unknown", snapshot, host)
    assert calls == ["model.decide"]


def tool_snapshot():
    return {
        "task": "tool-loop",
        "messages": [{"role": "user", "content": "word"}],
        "outputLanguage": "zh-CN",
        "targetLanguage": "en",
        "allowedOperations": ["model.decide", "learning.lookup"],
        "budget": {
            "timeoutMs": 1000,
            "maxModelCalls": 1,
            "maxToolCalls": 1,
            "maxSteps": 6,
            "maxInputChars": 8192,
            "maxOutputChars": 100,
        },
    }


async def test_budget_exhaustion_stops_a_loop():
    import pytest

    from lingo_agent.graphs.learning import LimitError

    calls = []

    async def host(operation, args):
        calls.append(operation)
        return (
            {"entries": ["carry"]}
            if operation == "learning.lookup"
            else {"kind": "tool", "name": "learning.lookup", "query": "carry"}
        )

    with pytest.raises(LimitError):
        await execute("bounded", tool_snapshot(), host)
    assert calls == ["model.decide", "learning.lookup"]


async def test_cancelled_model_never_schedules_a_tool():
    import asyncio

    import pytest

    started = asyncio.Event()
    calls = []

    async def host(operation, args):
        calls.append(operation)
        started.set()
        await asyncio.Future()

    task = asyncio.create_task(execute("cancel", tool_snapshot(), host))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert calls == ["model.decide"]


async def test_input_budget_is_checked_before_any_host_call():
    import pytest

    from lingo_agent.graphs.learning import LimitError

    snapshot = tool_snapshot()
    snapshot["messages"] = [{"role": "user", "content": "x" * 9000}]
    calls = []

    async def host(operation, args):
        calls.append(operation)
        return {"kind": "final", "text": "done"}

    with pytest.raises(LimitError):
        await execute("input-limit", snapshot, host)
    assert calls == []
