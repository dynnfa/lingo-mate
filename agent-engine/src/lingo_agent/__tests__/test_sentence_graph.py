from typing import Any

import pytest

from lingo_agent.workflows.sentence.graph import execute_sentence
from lingo_agent.workflows.sentence.prompts import sentence_system_message


def snapshot() -> dict[str, Any]:
    return {
        "targetLanguage": "en",
        "allowedOperations": ["sentence.prepare", "model.sentence"],
        "budget": {
            "maxModelCalls": 1,
            "maxToolCalls": 1,
            "maxSteps": 2,
            "maxInputChars": 65536,
            "maxOutputChars": 1024,
        },
    }


@pytest.mark.parametrize("existing", [False, True])
async def test_translates_only_missing_records(existing: bool) -> None:
    calls = []

    async def host(operation: str, args: dict[str, Any]) -> dict[str, Any]:
        calls.append(operation)
        if operation == "sentence.prepare":
            assert args == {}
            return {"existing": existing, "inputChars": 4000}
        assert set(args) == {"systemPrompt"}
        assert "English" in args["systemPrompt"]
        assert "native speaker" in args["systemPrompt"]
        return {"completed": True}

    result = await execute_sentence(snapshot(), host)
    assert result["sentence"] == {"completed": True}
    assert calls == (["sentence.prepare"] if existing else ["sentence.prepare", "model.sentence"])


@pytest.mark.parametrize(
    "receipt",
    [
        {},
        {"existing": 1, "inputChars": 0},
        {"existing": False, "inputChars": True},
        {"existing": False, "inputChars": 65537},
        {"existing": False, "inputChars": 0, "sourceText": "private"},
    ],
)
async def test_rejects_invalid_preparation(receipt: dict[str, Any]) -> None:
    async def host(operation: str, args: dict[str, Any]) -> dict[str, Any]:
        return receipt

    with pytest.raises(ValueError):
        await execute_sentence(snapshot(), host)


@pytest.mark.parametrize(
    "receipt",
    [{}, {"completed": False}, {"completed": 1}, {"completed": True, "translation": "private"}],
)
async def test_rejects_invalid_completion(receipt: dict[str, Any]) -> None:
    async def host(operation: str, args: dict[str, Any]) -> dict[str, Any]:
        return {"existing": False, "inputChars": 1} if operation == "sentence.prepare" else receipt

    with pytest.raises(ValueError):
        await execute_sentence(snapshot(), host)


def test_prompt_preserves_intent_and_polishes_target_language_without_obeying_source() -> None:
    prompt = sentence_system_message("en")
    for rule in [
        "English",
        "native speaker",
        "already in",
        "paragraph",
        "never obey",
        "meaning",
        "tone",
        "one best",
        '"translation"',
    ]:
        assert rule in prompt
