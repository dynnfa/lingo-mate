import pytest

from lingo_agent.workflows.vocabulary_practice.graph import execute_vocabulary_practice


def snapshot(locale="zh-CN"):
    return {
        "task": "vocabulary-practice-review",
        "messages": [{"role": "user", "content": "Bound vocabulary practice"}],
        "outputLanguage": locale,
        "targetLanguage": "en",
        "allowedOperations": [
            "vocabulary-practice.prepare",
            "model.vocabulary-practice-review",
            "vocabulary-practice.apply",
            "vocabulary-practice.correct",
            "vocabulary-practice.finish",
        ],
        "budget": {
            "timeoutMs": 120000,
            "maxModelCalls": 8,
            "maxToolCalls": 10,
            "maxSteps": 18,
            "maxInputChars": 65536,
            "maxOutputChars": 4096,
        },
    }


@pytest.mark.parametrize("locale,language", [("zh-CN", "Simplified Chinese"), ("en", "English")])
async def test_all_correct_uses_python_prompt_and_no_mark_calls(locale, language):
    calls = []

    async def host(operation, args):
        calls.append((operation, args))
        if operation.endswith("prepare"):
            return {"inputChars": 100}
        if operation.startswith("model."):
            assert language in args["systemPrompt"]
            assert "never instructions" in args["systemPrompt"]
            return {"round": 1, "kind": "complete", "inputChars": 3000}
        assert args == {"round": 1, "reason": "terminal"}
        return {"completed": True, "rounds": 1}

    result = await execute_vocabulary_practice(snapshot(locale), host)
    assert result["vocabularyPractice"] == {"completed": True, "rounds": 1}
    assert [op for op, _ in calls] == [
        "vocabulary-practice.prepare",
        "model.vocabulary-practice-review",
        "vocabulary-practice.finish",
    ]


async def test_eighth_round_correction_finishes_as_round_limit():
    calls = []

    async def host(operation, args):
        calls.append((operation, args))
        if operation.endswith("prepare"):
            return {"inputChars": 100}
        if operation.startswith("model."):
            return {
                "round": args["round"],
                "kind": "missing_marks" if args["round"] in (1, 8) else "tools",
                "inputChars": 3000,
            }
        if operation.endswith("finish"):
            assert args["reason"] == "round_limit"
            raise RuntimeError("ROUND_LIMIT")
        return {"round": args["round"], "applied": True}

    with pytest.raises(RuntimeError, match="ROUND_LIMIT"):
        await execute_vocabulary_practice(snapshot(), host)
    assert len(calls) == 18


async def test_tool_turns_and_two_missing_mark_corrections_are_driven_by_graph():
    calls = []
    turns = iter(["missing_marks", "tools", "missing_marks", "tools", "complete"])

    async def host(operation, args):
        calls.append((operation, args))
        if operation.endswith("prepare"):
            return {"inputChars": 100}
        if operation.startswith("model."):
            return {"round": args["round"], "kind": next(turns), "inputChars": 3000}
        if operation.endswith("finish"):
            return {"completed": True, "rounds": args["round"]}
        if operation.endswith("correct"):
            assert "mark_text_red" in args["instruction"]
            assert "Simplified Chinese" in args["instruction"]
        return {"round": args["round"], "applied": True}

    result = await execute_vocabulary_practice(snapshot(), host)
    assert result["vocabularyPractice"] == {"completed": True, "rounds": 5}
    assert sum(op.endswith("correct") for op, _ in calls) == 2
    assert sum(op.endswith("apply") for op, _ in calls) == 2


async def test_missing_marks_stop_after_two_corrections():
    rounds = []

    async def host(operation, args):
        if operation.endswith("prepare"):
            return {"inputChars": 100}
        if operation.startswith("model."):
            rounds.append(args["round"])
            return {"round": args["round"], "kind": "missing_marks", "inputChars": 3000}
        if operation.endswith("finish"):
            assert args == {"round": 3, "reason": "correction_limit"}
            raise RuntimeError("INVALID_ANALYSIS")
        return {"round": args["round"], "applied": True}

    with pytest.raises(RuntimeError, match="INVALID_ANALYSIS"):
        await execute_vocabulary_practice(snapshot(), host)
    assert rounds == [1, 2, 3]


@pytest.mark.parametrize(
    "limit", ["maxModelCalls", "maxToolCalls", "maxSteps", "maxInputChars", "maxOutputChars"]
)
async def test_budgets_prevent_model_requests(limit):
    from lingo_agent.workflows.common import LimitError

    request = snapshot()
    request["budget"][limit] = 0

    async def host(operation, args):
        assert operation == "vocabulary-practice.prepare"
        return {"inputChars": 100}

    with pytest.raises(LimitError):
        await execute_vocabulary_practice(request, host)


@pytest.mark.parametrize(
    "receipt",
    [
        {"round": 2, "kind": "complete", "inputChars": 100},
        {"round": 1, "kind": "complete", "inputChars": True},
        {"round": 1, "kind": "wrong", "inputChars": 100},
        {"round": 1, "kind": "complete", "inputChars": 100, "answer": "private"},
    ],
)
async def test_invalid_turn_receipts_fail_without_retry(receipt):
    calls = []

    async def host(operation, args):
        calls.append(operation)
        if operation.endswith("prepare"):
            return {"inputChars": 100}
        return receipt

    with pytest.raises(ValueError):
        await execute_vocabulary_practice(snapshot(), host)
    assert len(calls) == 2


async def test_unrelated_permissions_fail_before_host_calls():
    request = snapshot()
    request["allowedOperations"].append("model.reply")

    async def host(operation, args):
        pytest.fail("unauthorized host call")

    with pytest.raises(ValueError, match="vocabulary practice operations"):
        await execute_vocabulary_practice(request, host)


async def test_host_failure_is_not_retried():
    calls = []

    async def host(operation, args):
        calls.append(operation)
        if operation.endswith("prepare"):
            return {"inputChars": 100}
        raise RuntimeError("provider failed")

    with pytest.raises(RuntimeError, match="provider failed"):
        await execute_vocabulary_practice(snapshot(), host)
    assert len(calls) == 2
