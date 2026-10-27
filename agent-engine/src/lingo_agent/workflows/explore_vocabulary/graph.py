import json
from typing import Any, TypedDict, cast

from langgraph.graph import END, START, StateGraph

from lingo_agent.workflows.common import HostCall, LimitError, chars
from lingo_agent.workflows.explore_vocabulary.prompts import explore_vocabulary_system_message

EXPLORE_VOCABULARY_ITEM_COUNT = 10
MAX_EXPLORE_VOCABULARY_ATTEMPTS = 3


class ExploreVocabularyState(TypedDict):
    acceptedCount: int
    attempts: int
    inputChars: int
    outputChars: int
    exploreVocabulary: dict[str, int]


async def execute_explore_vocabulary(
    snapshot: dict[str, Any], host: HostCall
) -> ExploreVocabularyState:
    budget = snapshot["budget"]
    if set(snapshot["allowedOperations"]) != {
        "explore-vocabulary.prepare",
        "model.explore-vocabulary",
    }:
        raise ValueError("exploration operations")
    prompt = explore_vocabulary_system_message(snapshot["outputLanguage"])
    if chars(prompt) > 4096:
        raise LimitError()

    def receipt(result: dict[str, Any], previous: int, output_chars: int) -> dict[str, Any]:
        accepted = result["acceptedCount"]
        size = result["inputChars"]
        if (
            type(accepted) is not int
            or not previous <= accepted <= EXPLORE_VOCABULARY_ITEM_COUNT
            or type(size) is not int
            or not 0 <= size <= 65536
        ):
            raise ValueError("exploration receipt")
        output_chars += chars(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        if output_chars > budget["maxOutputChars"]:
            raise LimitError()
        return {"acceptedCount": accepted, "inputChars": size, "outputChars": output_chars}

    async def prepare(state: ExploreVocabularyState) -> dict[str, Any]:
        if budget["maxToolCalls"] < 1 or budget["maxSteps"] < 3:
            raise LimitError()
        result = await host("explore-vocabulary.prepare", {})
        if result["acceptedCount"] != 0:
            raise ValueError("exploration preparation")
        return receipt(result, 0, 0)

    async def generate(state: ExploreVocabularyState) -> dict[str, Any]:
        attempt = state["attempts"] + 1
        if (
            attempt > min(MAX_EXPLORE_VOCABULARY_ATTEMPTS, budget["maxModelCalls"])
            or attempt + 2 > budget["maxSteps"]
            or state["inputChars"] + chars(prompt) > budget["maxInputChars"]
        ):
            raise LimitError()
        result = await host(
            "model.explore-vocabulary", {"attempt": attempt, "systemPrompt": prompt}
        )
        if result["attempt"] != attempt:
            raise ValueError("exploration attempt ownership")
        return {
            **receipt(result, state["acceptedCount"], state["outputChars"]),
            "attempts": attempt,
        }

    def finalize(state: ExploreVocabularyState) -> dict[str, Any]:
        return {
            "exploreVocabulary": {
                "attempts": state["attempts"],
                "acceptedCount": state["acceptedCount"],
            }
        }

    graph = StateGraph(ExploreVocabularyState)
    graph.add_node("prepare", prepare)
    graph.add_node("generate", generate)
    graph.add_node("finalize", finalize)
    graph.add_edge(START, "prepare")
    graph.add_edge("prepare", "generate")
    graph.add_conditional_edges(
        "generate",
        lambda state: (
            "finalize"
            if state["acceptedCount"] == EXPLORE_VOCABULARY_ITEM_COUNT
            or state["attempts"] == MAX_EXPLORE_VOCABULARY_ATTEMPTS
            else "generate"
        ),
    )
    graph.add_edge("finalize", END)
    return cast(
        ExploreVocabularyState,
        await graph.compile().ainvoke(
            {
                "acceptedCount": 0,
                "attempts": 0,
                "inputChars": 0,
                "outputChars": 0,
                "exploreVocabulary": {},
            },
            {"recursion_limit": snapshot["budget"]["maxSteps"]},
        ),
    )
