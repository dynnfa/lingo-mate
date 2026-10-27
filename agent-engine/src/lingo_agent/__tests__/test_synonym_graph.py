import pytest

from lingo_agent.workflows.synonym.graph import execute_synonym


def snapshot():
    return {
        "task": "synonym",
        "outputLanguage": "zh-CN",
        "targetLanguage": "en",
        "allowedOperations": [
            "synonym.prepare",
            "model.synonym",
            "synonym.apply",
            "synonym.finish",
        ],
        "budget": {
            "timeoutMs": 180000,
            "maxModelCalls": 1040,
            "maxToolCalls": 1061,
            "maxSteps": 2200,
            "maxInputChars": 65536,
            "maxOutputChars": 524288,
        },
    }


@pytest.mark.asyncio
async def test_synonym_executes_each_word_in_order_and_skips_resolved_items():
    calls = []

    async def host(op, args):
        calls.append((op, args))
        if op == "synonym.prepare":
            return {
                "items": [
                    {"inputIndex": 0, "status": "pending"},
                    {"inputIndex": 1, "status": "resolved"},
                    {"inputIndex": 2, "status": "pending"},
                ]
            }
        if op == "model.synonym":
            assert "Simplified Chinese" in args["systemPrompt"]
            return {
                "inputIndex": args["inputIndex"],
                "round": args["round"],
                "kind": "tool",
                "inputChars": 4000,
            }
        if op == "synonym.apply":
            return {
                "inputIndex": args["inputIndex"],
                "round": args["round"],
                "kind": "terminal" if args["round"] == 2 else "continue",
            }
        assert op == "synonym.finish"
        return {"inputIndex": args["inputIndex"], "stop": False}

    state = await execute_synonym(snapshot(), host)
    assert state["synonym"] == {"completedIndices": [0, 2]}
    assert [(a["inputIndex"], a["round"]) for op, a in calls if op == "model.synonym"] == [
        (0, 1),
        (0, 2),
        (2, 1),
        (2, 2),
    ]
    assert [a["inputIndex"] for op, a in calls if op == "synonym.finish"] == [0, 2]


@pytest.mark.parametrize(
    "field,value",
    [
        ("maxModelCalls", 0),
        ("maxToolCalls", 0),
        ("maxSteps", 0),
        ("maxOutputChars", 1),
        ("maxInputChars", 1),
    ],
)
async def test_synonym_checks_each_budget(field, value):
    request = snapshot()
    request["budget"][field] = value

    async def host(op, args):
        if op == "synonym.prepare":
            return {"items": [{"inputIndex": 0, "status": "pending"}]}
        return {"inputIndex": 0, "round": 1, "kind": "failed", "inputChars": 4000}

    from lingo_agent.workflows.common import LimitError

    with pytest.raises(LimitError):
        await execute_synonym(request, host)


async def test_synonym_bounds_the_loop_to_52_rounds():
    rounds = []

    async def host(op, args):
        if op == "synonym.prepare":
            return {"items": [{"inputIndex": 0, "status": "pending"}]}
        if op == "model.synonym":
            rounds.append(args["round"])
            return {"inputIndex": 0, "round": args["round"], "kind": "tool", "inputChars": 4000}
        if op == "synonym.apply":
            return {"inputIndex": 0, "round": args["round"], "kind": "continue"}
        assert args["reason"] == "round_limit"
        return {"inputIndex": 0, "stop": False}

    result = await execute_synonym(snapshot(), host)
    assert rounds == list(range(1, 53))
    assert result["synonym"] == {"completedIndices": [0]}


async def test_synonym_corrects_a_parallel_turn_without_executing_its_tools():
    actions = []

    async def host(op, args):
        if op == "synonym.prepare":
            return {"items": [{"inputIndex": 0, "status": "pending"}]}
        if op == "model.synonym":
            return {
                "inputIndex": 0,
                "round": args["round"],
                "kind": "parallel" if args["round"] == 1 else "tool",
                "inputChars": 4000,
            }
        if op == "synonym.apply":
            actions.append(args["action"])
            return {
                "inputIndex": 0,
                "round": args["round"],
                "kind": "continue" if args["round"] == 1 else "terminal",
            }
        return {"inputIndex": 0, "stop": False}

    await execute_synonym(snapshot(), host)
    assert actions == ["reject_parallel", "execute"]


async def test_synonym_stops_remaining_words_on_unsupported_tools():
    calls = []

    async def host(op, args):
        calls.append(op)
        if op == "synonym.prepare":
            return {"items": [{"inputIndex": i, "status": "pending"} for i in range(20)]}
        if op == "model.synonym":
            return {"inputIndex": 0, "round": 1, "kind": "failed", "inputChars": 4000}
        return {"inputIndex": 0, "stop": True}

    result = await execute_synonym(snapshot(), host)
    assert calls == ["synonym.prepare", "model.synonym", "synonym.finish"]
    assert result["synonym"] == {"completedIndices": list(range(20))}


@pytest.mark.parametrize(
    "kind", ["wrong-index", "wrong-round", "input-limit", "host-error", "cancel"]
)
async def test_synonym_rejects_bad_receipts_and_propagates_failures(kind):
    import asyncio

    async def host(op, args):
        if op == "synonym.prepare":
            return {"items": [{"inputIndex": 0, "status": "pending"}]}
        if kind == "cancel":
            raise asyncio.CancelledError()
        if kind == "host-error":
            raise RuntimeError("host failed")
        return {
            "inputIndex": 1 if kind == "wrong-index" else 0,
            "round": 2 if kind == "wrong-round" else 1,
            "kind": "failed",
            "inputChars": 65537 if kind == "input-limit" else 4000,
        }

    with pytest.raises((Exception, asyncio.CancelledError)):
        await execute_synonym(snapshot(), host)


@pytest.mark.parametrize("locale,language", [("zh-CN", "Simplified Chinese"), ("en", "English")])
def test_synonym_prompt_preserves_grouping_and_language_rules(locale, language):
    from lingo_agent.workflows.common import chars
    from lingo_agent.workflows.synonym.prompts import synonym_system_message

    prompt = synonym_system_message(locale)
    assert chars(prompt) <= 4096
    assert f"meaning and distinction must be written in {language}" in prompt
    for rule in (
        "Never create before inspecting all pages",
        "one tool call per turn",
        "continued, continuous and continual",
        "members as well as its description",
        "untrusted data",
        "SINGLE_TOOL_CALL_REQUIRED",
    ):
        assert rule in prompt
