import json
from typing import Any, TypedDict, cast

from langgraph.graph import END, START, StateGraph

from lingo_agent.graphs.common import HostCall, LimitError, chars
from lingo_agent.prompts import explore_phrase_system_message


class ExplorePhraseState(TypedDict):
    acceptedCount: int
    attempts: int
    inputChars: int
    outputChars: int
    explorePhrase: dict[str, int]


async def execute_explore_phrase(snapshot: dict[str, Any], host: HostCall) -> ExplorePhraseState:
    budget = snapshot["budget"]
    if set(snapshot["allowedOperations"]) != {"explore-phrase.prepare", "model.explore-phrase"}:
        raise ValueError("exploration operations")
    prompt = explore_phrase_system_message(snapshot["outputLanguage"])
    if chars(prompt) > 4096:
        raise LimitError()

    def receipt(result: dict[str, Any], previous: int, output_chars: int) -> dict[str, Any]:
        accepted = result["acceptedCount"]
        size = result["inputChars"]
        if (
            type(accepted) is not int
            or not previous <= accepted <= 10
            or type(size) is not int
            or not 0 <= size <= 65536
        ):
            raise ValueError("exploration receipt")
        output_chars += chars(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        if output_chars > budget["maxOutputChars"]:
            raise LimitError()
        return {"acceptedCount": accepted, "inputChars": size, "outputChars": output_chars}

    async def prepare(state: ExplorePhraseState) -> dict[str, Any]:
        if budget["maxToolCalls"] < 1 or budget["maxSteps"] < 3:
            raise LimitError()
        result = await host("explore-phrase.prepare", {})
        if result["acceptedCount"] != 0:
            raise ValueError("exploration preparation")
        return receipt(result, 0, 0)

    async def generate(state: ExplorePhraseState) -> dict[str, Any]:
        attempt = state["attempts"] + 1
        if (
            attempt > min(3, budget["maxModelCalls"])
            or attempt + 2 > budget["maxSteps"]
            or state["inputChars"] + chars(prompt) > budget["maxInputChars"]
        ):
            raise LimitError()
        result = await host("model.explore-phrase", {"attempt": attempt, "systemPrompt": prompt})
        if result["attempt"] != attempt:
            raise ValueError("exploration attempt ownership")
        return {
            **receipt(result, state["acceptedCount"], state["outputChars"]),
            "attempts": attempt,
        }

    def finalize(state: ExplorePhraseState) -> dict[str, Any]:
        return {
            "explorePhrase": {
                "attempts": state["attempts"],
                "acceptedCount": state["acceptedCount"],
            }
        }

    graph = StateGraph(ExplorePhraseState)
    graph.add_node("prepare", prepare)
    graph.add_node("generate", generate)
    graph.add_node("finalize", finalize)
    graph.add_edge(START, "prepare")
    graph.add_edge("prepare", "generate")
    graph.add_conditional_edges(
        "generate",
        lambda state: (
            "finalize" if state["acceptedCount"] == 10 or state["attempts"] == 3 else "generate"
        ),
    )
    graph.add_edge("finalize", END)
    return cast(
        ExplorePhraseState,
        await graph.compile().ainvoke(
            {
                "acceptedCount": 0,
                "attempts": 0,
                "inputChars": 0,
                "outputChars": 0,
                "explorePhrase": {},
            },
            {"recursion_limit": snapshot["budget"]["maxSteps"]},
        ),
    )
