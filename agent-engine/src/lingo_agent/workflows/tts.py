"""Deterministic speech synthesis. This graph has no model capability."""

from typing import Any, TypedDict, cast

from langgraph.graph import END, START, StateGraph

from lingo_agent.workflows.common import HostCall


class TtsState(TypedDict):
    tts: dict[str, bool]


async def execute_tts(snapshot: dict[str, Any], host: HostCall) -> TtsState:
    if snapshot["allowedOperations"] != ["tts.synthesize"]:
        raise ValueError("speech operations")
    if snapshot["budget"]["maxModelCalls"] != 0:
        raise ValueError("speech model budget")

    async def synthesize(state: TtsState) -> TtsState:
        result = await host("tts.synthesize", {})
        if result != {"completed": True} or type(result["completed"]) is not bool:
            raise ValueError("speech completion")
        return {"tts": {"completed": True}}

    graph = StateGraph(TtsState)
    graph.add_node("synthesize", synthesize)
    graph.add_edge(START, "synthesize")
    graph.add_edge("synthesize", END)
    return cast(TtsState, await graph.compile().ainvoke({"tts": {}}, {"recursion_limit": 2}))
