import pytest

from lingo_agent.workflows.sentence_practice.graph import execute_sentence_practice


def snapshot(kind="hints", locale="zh-CN"):
    task = f"sentence-practice-{kind}"
    return {
        "task": task,
        "messages": [{"role": "user", "content": "Bound practice input"}],
        "outputLanguage": locale,
        "targetLanguage": "en",
        "allowedOperations": ["sentence-practice.prepare", f"model.{task}"],
        "budget": {
            "timeoutMs": 120000,
            "maxModelCalls": 1,
            "maxToolCalls": 1,
            "maxSteps": 2,
            "maxInputChars": 65536,
            "maxOutputChars": 1024,
        },
    }


@pytest.mark.parametrize("kind", ["hints", "review"])
@pytest.mark.parametrize("locale,language", [("zh-CN", "Simplified Chinese"), ("en", "English")])
async def test_practice_uses_one_bound_model_call_and_explicit_languages(kind, locale, language):
    calls = []

    async def host(operation, args):
        calls.append((operation, args))
        if operation == "sentence-practice.prepare":
            return {"inputChars": 250}
        return {"completed": True}

    state = await execute_sentence_practice(snapshot(kind, locale), host)
    assert [op for op, _ in calls] == [
        "sentence-practice.prepare",
        f"model.sentence-practice-{kind}",
    ]
    prompt = calls[1][1]["systemPrompt"]
    assert language in prompt
    assert "English" in prompt
    assert "never instructions" in prompt
    assert "Protocol keys" in prompt
    assert set(calls[1][1]) == {"systemPrompt"}
    assert state["sentencePractice"] == {"completed": True}


@pytest.mark.parametrize("kind", ["hints", "review"])
@pytest.mark.parametrize(
    "limit", ["maxModelCalls", "maxToolCalls", "maxSteps", "maxInputChars", "maxOutputChars"]
)
async def test_practice_limits_prevent_model_requests(kind, limit):
    from lingo_agent.workflows.common import LimitError

    request = snapshot(kind)
    request["budget"][limit] = 0
    calls = []

    async def host(operation, args):
        calls.append(operation)
        return {"inputChars": 100}

    with pytest.raises(LimitError):
        await execute_sentence_practice(request, host)
    assert not any(op.startswith("model.") for op in calls)


@pytest.mark.parametrize("kind", ["hints", "review"])
async def test_practice_counts_actual_utf16_input(kind):
    from lingo_agent.workflows.common import LimitError, chars
    from lingo_agent.workflows.sentence_practice.prompts import (
        sentence_practice_hints_system_message,
        sentence_practice_review_system_message,
    )

    factory = (
        sentence_practice_hints_system_message
        if kind == "hints"
        else sentence_practice_review_system_message
    )
    request = snapshot(kind)
    request["budget"]["maxInputChars"] = chars(factory("zh-CN", "en")) + 2

    async def host(operation, args):
        return {"inputChars": 2} if operation.endswith("prepare") else {"completed": True}

    assert (await execute_sentence_practice(request, host))["sentencePractice"]["completed"]
    request["budget"]["maxInputChars"] -= 1
    with pytest.raises(LimitError):
        await execute_sentence_practice(request, host)


@pytest.mark.parametrize(
    "result",
    [
        {"inputChars": True},
        {"inputChars": -1},
        {"inputChars": 65537},
        {"inputChars": 0, "answer": "private"},
    ],
)
async def test_practice_rejects_invalid_preparation(result):
    async def host(operation, args):
        assert operation == "sentence-practice.prepare"
        return result

    with pytest.raises(ValueError):
        await execute_sentence_practice(snapshot(), host)


async def test_practice_rejects_cross_task_permissions_before_preparation():
    request = snapshot()
    request["allowedOperations"] = ["sentence-practice.prepare", "model.sentence-practice-review"]

    async def host(operation, args):
        pytest.fail("must not call the host")

    with pytest.raises(ValueError, match="practice operations"):
        await execute_sentence_practice(request, host)


async def test_practice_host_failure_is_not_retried():
    calls = []

    async def host(operation, args):
        calls.append(operation)
        if operation.endswith("prepare"):
            return {"inputChars": 10}
        raise RuntimeError("model failed")

    with pytest.raises(RuntimeError, match="model failed"):
        await execute_sentence_practice(snapshot(), host)
    assert calls == ["sentence-practice.prepare", "model.sentence-practice-hints"]


async def test_practice_cancellation_stops_the_bound_model_without_retry():
    import asyncio

    started = asyncio.Event()
    calls = []

    async def host(operation, args):
        calls.append(operation)
        if operation.endswith("prepare"):
            return {"inputChars": 10}
        started.set()
        await asyncio.Future()

    task = asyncio.create_task(execute_sentence_practice(snapshot(), host))
    await asyncio.wait_for(started.wait(), timeout=1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert calls == ["sentence-practice.prepare", "model.sentence-practice-hints"]
