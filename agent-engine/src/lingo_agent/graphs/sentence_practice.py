"""Bound sentence practice: prepare input sizes, then make exactly one model call."""

import json
from typing import Any, TypedDict, cast

from langgraph.graph import END, START, StateGraph

from lingo_agent.graphs.common import HostCall, LimitError, chars
from lingo_agent.prompts import (
    sentence_practice_hints_system_message,
    sentence_practice_review_system_message,
)


class SentencePracticeState(TypedDict):
    inputChars: int
    outputChars: int
    sentencePractice: dict[str, bool]


async def execute_sentence_practice(
    snapshot: dict[str, Any], host: HostCall
) -> SentencePracticeState:
    operation = f"model.{snapshot['task']}"
    if set(snapshot["allowedOperations"]) != {"sentence-practice.prepare", operation}:
        raise ValueError("practice operations")
    prompt_factory = (
        sentence_practice_hints_system_message
        if snapshot["task"] == "sentence-practice-hints"
        else sentence_practice_review_system_message
    )
    prompt = prompt_factory(snapshot["outputLanguage"], snapshot["targetLanguage"])
    budget = snapshot["budget"]
    if chars(prompt) > 4096 or budget["maxToolCalls"] < 1 or budget["maxSteps"] < 2:
        raise LimitError()

    def size(result: dict[str, Any]) -> int:
        return chars(json.dumps(result, ensure_ascii=False, separators=(",", ":")))

    async def prepare(state: SentencePracticeState) -> dict[str, Any]:
        result = await host("sentence-practice.prepare", {})
        count = result.get("inputChars")
        if set(result) != {"inputChars"} or type(count) is not int or not 0 <= count <= 65536:
            raise ValueError("practice preparation")
        if size(result) > budget["maxOutputChars"]:
            raise LimitError()
        return {"inputChars": count, "outputChars": size(result)}

    async def generate(state: SentencePracticeState) -> dict[str, Any]:
        if (
            budget["maxModelCalls"] < 1
            or state["inputChars"] + chars(prompt) > budget["maxInputChars"]
        ):
            raise LimitError()
        result = await host(operation, {"systemPrompt": prompt})
        if set(result) != {"completed"} or result["completed"] is not True:
            raise ValueError("practice receipt")
        if state["outputChars"] + size(result) > budget["maxOutputChars"]:
            raise LimitError()
        return {"sentencePractice": {"completed": True}}

    graph = StateGraph(SentencePracticeState)
    graph.add_node("prepare", prepare)
    graph.add_node("generate", generate)
    graph.add_edge(START, "prepare")
    graph.add_edge("prepare", "generate")
    graph.add_edge("generate", END)
    return cast(
        SentencePracticeState,
        await graph.compile().ainvoke(
            {"inputChars": 0, "outputChars": 0, "sentencePractice": {}},
            {"recursion_limit": budget["maxSteps"] + 1},
        ),
    )
