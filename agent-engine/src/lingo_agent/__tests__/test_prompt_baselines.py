"""Compare every prompt with fixed outputs captured before workflow migration."""

import json
from pathlib import Path

import pytest

from lingo_agent.workflows.conversation.prompts import (
    conversation_system_message,
    conversation_title_system_message,
    word_concept_system_message,
)
from lingo_agent.workflows.explore_phrase.prompts import explore_phrase_system_message
from lingo_agent.workflows.explore_vocabulary.prompts import explore_vocabulary_system_message
from lingo_agent.workflows.phrase.prompts import phrase_system_message
from lingo_agent.workflows.sentence_practice.prompts import (
    sentence_practice_hints_system_message,
    sentence_practice_review_system_message,
)
from lingo_agent.workflows.synonym.prompts import synonym_system_message
from lingo_agent.workflows.vocabulary.prompts import vocabulary_system_message
from lingo_agent.workflows.vocabulary_practice.prompts import (
    vocabulary_practice_marks_required_message,
    vocabulary_practice_review_system_message,
)

FACTORIES = {
    factory.__name__: factory
    for factory in (
        conversation_system_message,
        conversation_title_system_message,
        explore_phrase_system_message,
        explore_vocabulary_system_message,
        phrase_system_message,
        sentence_practice_hints_system_message,
        sentence_practice_review_system_message,
        synonym_system_message,
        vocabulary_practice_marks_required_message,
        vocabulary_practice_review_system_message,
        vocabulary_system_message,
        word_concept_system_message,
    )
}
BASELINES = json.loads((Path(__file__).parent / "fixtures/prompt-baselines.json").read_text())


@pytest.mark.parametrize(
    "case", BASELINES, ids=[f"{case['factory']}:{','.join(case['args'])}" for case in BASELINES]
)
def test_prompt_matches_pre_migration_output(case):
    assert FACTORIES[case["factory"]](*case["args"]) == case["text"]
