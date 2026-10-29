"""Prepare, optionally translate, then release only a verified completion receipt."""

import json
from typing import Any, TypedDict, cast

from langgraph.graph import END, START, StateGraph

from lingo_agent.workflows.common import HostCall, LimitError, chars
from lingo_agent.workflows.sentence.prompts import sentence_system_message


class SentenceState(TypedDict):
    existing: bool
    inputChars: int
    outputChars: int
    sentence: dict[str, bool]


async def execute_sentence(snapshot: dict[str, Any], host: HostCall) -> SentenceState:
    if set(snapshot["allowedOperations"]) != {"sentence.prepare", "model.sentence"}:
        raise ValueError("sentence operations")
    prompt = sentence_system_message(snapshot["targetLanguage"])
    budget = snapshot["budget"]
    if chars(prompt) > 4096 or budget["maxToolCalls"] < 1 or budget["maxSteps"] < 2:
        raise LimitError()

    def size(result: dict[str, Any]) -> int:
        return chars(json.dumps(result, ensure_ascii=False, separators=(",", ":")))

    async def prepare(state: SentenceState) -> dict[str, Any]:
        result = await host("sentence.prepare", {})
        count = result.get("inputChars")
        if (
            set(result) != {"existing", "inputChars"}
            or type(result["existing"]) is not bool
            or type(count) is not int
            or not 0 <= count <= 65536
        ):
            raise ValueError("sentence preparation")
        if size(result) > budget["maxOutputChars"]:
            raise LimitError()
        return {
            **result,
            "outputChars": size(result),
            "sentence": {"completed": True} if result["existing"] else {},
        }

    async def translate(state: SentenceState) -> dict[str, Any]:
        if (
            budget["maxModelCalls"] < 1
            or state["inputChars"] + chars(prompt) > budget["maxInputChars"]
        ):
            raise LimitError()
        result = await host("model.sentence", {"systemPrompt": prompt})
        if set(result) != {"completed"} or result["completed"] is not True:
            raise ValueError("sentence receipt")
        if state["outputChars"] + size(result) > budget["maxOutputChars"]:
            raise LimitError()
        return {"sentence": {"completed": True}}

    graph = StateGraph(SentenceState)
    graph.add_node("prepare", prepare)
    graph.add_node("translate", translate)
    graph.add_edge(START, "prepare")
    graph.add_conditional_edges("prepare", lambda state: END if state["existing"] else "translate")
    graph.add_edge("translate", END)
    return cast(
        SentenceState,
        await graph.compile().ainvoke(
            {"existing": False, "inputChars": 0, "outputChars": 0, "sentence": {}},
            {"recursion_limit": budget["maxSteps"] + 1},
        ),
    )
