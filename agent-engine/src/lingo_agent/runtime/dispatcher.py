"""Explicit task selection; workflow policy and execution stay in workflows."""

from typing import Any

from lingo_agent.state import LearningState
from lingo_agent.workflows.common import HostCall
from lingo_agent.workflows.conversation.routing import execute_conversation_route
from lingo_agent.workflows.conversation.title import execute_title
from lingo_agent.workflows.explore_phrase.graph import ExplorePhraseState, execute_explore_phrase
from lingo_agent.workflows.explore_vocabulary.graph import (
    ExploreVocabularyState,
    execute_explore_vocabulary,
)
from lingo_agent.workflows.phrase.graph import PhraseState, execute_phrase
from lingo_agent.workflows.sentence_practice.graph import (
    SentencePracticeState,
    execute_sentence_practice,
)
from lingo_agent.workflows.synonym.graph import SynonymState, execute_synonym
from lingo_agent.workflows.tool_loop import execute_tool_loop
from lingo_agent.workflows.tts import TtsState, execute_tts
from lingo_agent.workflows.vocabulary.graph import VocabularyState, execute_vocabulary
from lingo_agent.workflows.vocabulary_practice.graph import (
    VocabularyPracticeState,
    execute_vocabulary_practice,
)


async def execute(
    run_id: str, snapshot: dict[str, Any], host: HostCall
) -> (
    LearningState
    | TtsState
    | VocabularyState
    | PhraseState
    | SynonymState
    | ExplorePhraseState
    | ExploreVocabularyState
    | SentencePracticeState
    | VocabularyPracticeState
):
    task = snapshot["task"]
    if task == "conversation":
        return await execute_conversation_route(run_id, snapshot, host)
    if task == "conversation-title":
        return await execute_title(run_id, snapshot, host)
    if task == "vocabulary":
        return await execute_vocabulary(snapshot, host)
    if task == "phrase":
        return await execute_phrase(snapshot, host)
    if task == "synonym":
        return await execute_synonym(snapshot, host)
    if task == "explore-phrase":
        return await execute_explore_phrase(snapshot, host)
    if task == "explore-vocabulary":
        return await execute_explore_vocabulary(snapshot, host)
    if task in ("sentence-practice-hints", "sentence-practice-review"):
        return await execute_sentence_practice(snapshot, host)
    if task == "vocabulary-practice-review":
        return await execute_vocabulary_practice(snapshot, host)
    if task == "tts":
        return await execute_tts(snapshot, host)
    if task == "tool-loop":
        return await execute_tool_loop(run_id, snapshot, host)
    raise ValueError("unknown task")
