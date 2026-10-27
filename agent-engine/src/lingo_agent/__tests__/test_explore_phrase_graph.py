from lingo_agent.workflows.explore_phrase.graph import execute_explore_phrase


def snapshot(locale="zh-CN", **budget):
    return {
        "task": "explore-phrase",
        "messages": [{"role": "user", "content": "Exploration batch"}],
        "outputLanguage": locale,
        "targetLanguage": "en",
        "allowedOperations": ["explore-phrase.prepare", "model.explore-phrase"],
        "budget": {
            "timeoutMs": 180000,
            "maxModelCalls": 3,
            "maxToolCalls": 1,
            "maxSteps": 8,
            "maxInputChars": 65536,
            "maxOutputChars": 32768,
            **budget,
        },
    }


async def test_exploration_finishes_after_ten_accepted_items():
    calls = []

    async def host(operation, args):
        calls.append(operation)
        if operation == "explore-phrase.prepare":
            return {"acceptedCount": 0, "inputChars": 2000}
        assert operation == "model.explore-phrase"
        assert args["attempt"] == 1
        assert "Simplified Chinese (zh-CN)" in args["systemPrompt"]
        assert "English" in args["systemPrompt"]
        return {"attempt": 1, "acceptedCount": 10, "inputChars": 0}

    state = await execute_explore_phrase(snapshot(), host)
    assert calls == ["explore-phrase.prepare", "model.explore-phrase"]
    assert state["explorePhrase"] == {"attempts": 1, "acceptedCount": 10}


async def test_exploration_stops_after_three_attempts_with_remaining_items():
    attempts = []

    async def host(operation, args):
        if operation == "explore-phrase.prepare":
            return {"acceptedCount": 0, "inputChars": 1000}
        attempt = args["attempt"]
        attempts.append(attempt)
        assert "English (en)" in args["systemPrompt"]
        return {"attempt": attempt, "acceptedCount": attempt, "inputChars": 1000}

    state = await execute_explore_phrase(snapshot("en"), host)
    assert attempts == [1, 2, 3]
    assert state["explorePhrase"] == {"attempts": 3, "acceptedCount": 3}


async def test_exploration_checks_input_before_calling_the_model():
    import pytest

    from lingo_agent.workflows.common import LimitError

    calls = []

    async def host(operation, args):
        calls.append(operation)
        return {"acceptedCount": 0, "inputChars": 65536}

    with pytest.raises(LimitError):
        await execute_explore_phrase(snapshot(), host)
    assert calls == ["explore-phrase.prepare"]


async def test_exploration_rejects_bad_receipts_and_budget_exhaustion():
    import pytest

    from lingo_agent.workflows.common import LimitError

    for budget in ({"maxToolCalls": 0}, {"maxSteps": 2}, {"maxOutputChars": 1}):

        async def host(operation, args):
            return {"acceptedCount": 0, "inputChars": 1000}

        with pytest.raises(LimitError):
            await execute_explore_phrase(snapshot(**budget), host)

    async def invalid_host(operation, args):
        if operation == "explore-phrase.prepare":
            return {"acceptedCount": 0, "inputChars": 1000}
        return {"attempt": args["attempt"] + 1, "acceptedCount": 10, "inputChars": 0}

    with pytest.raises(ValueError, match="ownership"):
        await execute_explore_phrase(snapshot(), invalid_host)

    async def insufficient(operation, args):
        if operation == "explore-phrase.prepare":
            return {"acceptedCount": 0, "inputChars": 1000}
        return {"attempt": args["attempt"], "acceptedCount": 1, "inputChars": 1000}

    with pytest.raises(LimitError):
        await execute_explore_phrase(snapshot(maxModelCalls=1), insufficient)


async def test_exploration_propagates_cancellation_without_another_attempt():
    import asyncio

    import pytest

    calls = []
    started = asyncio.Event()

    async def host(operation, args):
        calls.append(operation)
        if operation == "explore-phrase.prepare":
            return {"acceptedCount": 0, "inputChars": 1000}
        started.set()
        await asyncio.Future()

    task = asyncio.create_task(execute_explore_phrase(snapshot(), host))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert calls == ["explore-phrase.prepare", "model.explore-phrase"]
