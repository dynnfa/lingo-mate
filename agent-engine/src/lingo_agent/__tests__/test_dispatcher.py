import pytest

from lingo_agent.runtime.dispatcher import execute

# Each exchange exercises the real selected graph with a controlled host.
TASK_CASES = [
    (
        "conversation",
        [("model.reply", {"text": "answer"})],
        "text",
        "answer",
    ),
    (
        "conversation-title",
        [("model.title", {"text": "title"})],
        "text",
        "title",
    ),
    (
        "vocabulary",
        [
            (
                "vocabulary.prepare",
                {"items": [{"inputIndex": 0, "term": "carry", "status": "pending"}]},
            ),
            ("model.vocabulary", {"inputIndex": 0, "status": "staged"}),
        ],
        "vocabulary",
        {"completedIndices": [0]},
    ),
    (
        "phrase",
        [
            (
                "phrase.prepare",
                {"items": [{"inputIndex": 0, "phrase": "carry on", "status": "pending"}]},
            ),
            ("model.phrase", {"inputIndex": 0, "status": "staged"}),
        ],
        "phrase",
        {"completedIndices": [0]},
    ),
    (
        "synonym",
        [
            ("synonym.prepare", {"items": [{"inputIndex": 0, "status": "pending"}]}),
            ("model.synonym", {"inputIndex": 0, "round": 1, "kind": "tool", "inputChars": 100}),
            ("synonym.apply", {"inputIndex": 0, "round": 1, "kind": "terminal"}),
            ("synonym.finish", {"inputIndex": 0, "stop": False}),
        ],
        "synonym",
        {"completedIndices": [0]},
    ),
    *[
        (
            task,
            [
                (f"{task}.prepare", {"acceptedCount": 0, "inputChars": 100}),
                (f"model.{task}", {"attempt": 1, "acceptedCount": 10, "inputChars": 0}),
            ],
            field,
            {"attempts": 1, "acceptedCount": 10},
        )
        for task, field in (
            ("explore-phrase", "explorePhrase"),
            ("explore-vocabulary", "exploreVocabulary"),
        )
    ],
    *[
        (
            task,
            [
                ("sentence-practice.prepare", {"inputChars": 100}),
                (f"model.{task}", {"completed": True}),
            ],
            "sentencePractice",
            {"completed": True},
        )
        for task in ("sentence-practice-hints", "sentence-practice-review")
    ],
    (
        "vocabulary-practice-review",
        [
            ("vocabulary-practice.prepare", {"inputChars": 100}),
            (
                "model.vocabulary-practice-review",
                {"round": 1, "kind": "complete", "inputChars": 100},
            ),
            ("vocabulary-practice.finish", {"completed": True, "rounds": 1}),
        ],
        "vocabularyPractice",
        {"completed": True, "rounds": 1},
    ),
    ("tts", [("tts.synthesize", {"completed": True})], "tts", {"completed": True}),
    (
        "tool-loop",
        [
            ("model.decide", {"kind": "tool", "name": "learning.lookup", "query": "carry"}),
            ("learning.lookup", {"entries": ["carry: transport"]}),
            ("model.decide", {"kind": "final", "text": "answer"}),
        ],
        "text",
        "answer",
    ),
]


def snapshot(task, exchanges):
    operations = list(dict.fromkeys(op for op, _ in exchanges))
    if task == "vocabulary-practice-review":
        operations.extend(["vocabulary-practice.apply", "vocabulary-practice.correct"])
    return {
        "task": task,
        "messages": [{"role": "user", "content": "hello"}],
        "outputLanguage": "en",
        "targetLanguage": "en",
        "allowedOperations": operations,
        "budget": {
            "timeoutMs": 120000,
            "maxInputChars": 65536,
            "maxOutputChars": 32768,
            "maxModelCalls": 0 if task == "tts" else 20,
            "maxToolCalls": 10,
            "maxSteps": 32,
        },
    }


@pytest.mark.parametrize("task,exchanges,field,result", TASK_CASES, ids=[c[0] for c in TASK_CASES])
async def test_dispatches_each_task_through_its_host_operations(task, exchanges, field, result):
    calls = []

    async def host(operation, args):
        expected, receipt = exchanges[len(calls)]
        calls.append(operation)
        assert operation == expected
        if operation.startswith("model.") and operation != "model.decide":
            assert args["systemPrompt"]
        return receipt

    state = await execute("dispatch", snapshot(task, exchanges), host)
    assert calls == [op for op, _ in exchanges]
    assert state[field] == result


@pytest.mark.parametrize(
    "task,exchanges,fail_at",
    [
        pytest.param(task, exchanges, index, id=f"{task}:{index}:{operation}")
        for task, exchanges, _, _ in TASK_CASES
        for index, (operation, _) in enumerate(exchanges)
    ],
)
async def test_host_failure_keeps_original_error_and_stops_without_retry(task, exchanges, fail_at):
    error = RuntimeError("host failed")
    calls = []

    async def host(operation, args):
        index = len(calls)
        calls.append(operation)
        assert operation == exchanges[index][0]
        if index == fail_at:
            raise error
        return exchanges[index][1]

    with pytest.raises(RuntimeError) as caught:
        await execute("failure", snapshot(task, exchanges), host)
    assert caught.value is error
    assert calls == [op for op, _ in exchanges[: fail_at + 1]]


@pytest.mark.parametrize("task", ["unknown", "Conversation", ""])
async def test_unknown_task_is_rejected_before_any_host_call(task):
    calls = []

    async def host(operation, args):
        calls.append(operation)
        return {"text": "must not reply"}

    with pytest.raises(ValueError, match="unknown task"):
        await execute(
            "unknown-task",
            {
                "task": task,
                "messages": [{"role": "user", "content": "hello"}],
                "outputLanguage": "en",
                "targetLanguage": "en",
                "allowedOperations": ["model.reply"],
                "budget": {
                    "maxInputChars": 8192,
                    "maxOutputChars": 100,
                    "maxModelCalls": 1,
                    "maxSteps": 1,
                },
            },
            host,
        )
    assert calls == []
