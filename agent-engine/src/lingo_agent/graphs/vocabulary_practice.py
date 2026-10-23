"""Bound vocabulary review. Python owns the tool loop and missing-mark correction policy."""

import json
from typing import Any, TypedDict, cast

from langgraph.graph import END, START, StateGraph

from lingo_agent.graphs.common import HostCall, LimitError, chars
from lingo_agent.prompts import (
    vocabulary_practice_marks_required_message,
    vocabulary_practice_review_system_message,
)

OPERATIONS = {
    "vocabulary-practice.prepare",
    "model.vocabulary-practice-review",
    "vocabulary-practice.apply",
    "vocabulary-practice.correct",
    "vocabulary-practice.finish",
}


class VocabularyPracticeState(TypedDict):
    round: int
    corrections: int
    kind: str
    vocabularyPractice: dict[str, Any]


async def execute_vocabulary_practice(
    snapshot: dict[str, Any], host: HostCall
) -> VocabularyPracticeState:
    if set(snapshot["allowedOperations"]) != OPERATIONS:
        raise ValueError("vocabulary practice operations")
    budget = snapshot["budget"]
    prompt = vocabulary_practice_review_system_message(snapshot["outputLanguage"])
    correction = vocabulary_practice_marks_required_message(snapshot["outputLanguage"])
    if chars(prompt) > 4096 or chars(correction) > 4096:
        raise LimitError()
    models = tools = steps = output = 0

    async def call(operation: str, args: dict[str, Any]) -> dict[str, Any]:
        nonlocal models, tools, steps, output
        steps += 1
        if operation.startswith("model."):
            models += 1
        else:
            tools += 1
        if (
            models > budget["maxModelCalls"]
            or tools > budget["maxToolCalls"]
            or steps > budget["maxSteps"]
        ):
            raise LimitError()
        result = await host(operation, args)
        output += chars(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        if output > budget["maxOutputChars"]:
            raise LimitError()
        if "round" in args and operation != "vocabulary-practice.finish":
            if result.get("round") != args["round"]:
                raise ValueError("vocabulary practice round ownership")
        return result

    async def prepare(state: VocabularyPracticeState) -> dict[str, Any]:
        result = await call("vocabulary-practice.prepare", {})
        count = result.get("inputChars")
        if set(result) != {"inputChars"} or type(count) is not int or count < 0:
            raise ValueError("vocabulary practice preparation")
        if count + chars(prompt) > budget["maxInputChars"]:
            raise LimitError()
        return {}

    async def model(state: VocabularyPracticeState) -> dict[str, Any]:
        round_ = state["round"] + 1
        result = await call(
            "model.vocabulary-practice-review",
            {
                "round": round_,
                "systemPrompt": prompt,
            },
        )
        count = result.get("inputChars")
        if (
            set(result) != {"round", "kind", "inputChars"}
            or type(count) is not int
            or count < 0
            or result["kind"] not in ("tools", "complete", "missing_marks")
        ):
            raise ValueError("vocabulary practice model receipt")
        if count > budget["maxInputChars"]:
            raise LimitError()
        return {"round": round_, "kind": result["kind"]}

    async def apply(state: VocabularyPracticeState) -> dict[str, Any]:
        result = await call("vocabulary-practice.apply", {"round": state["round"]})
        if result != {"round": state["round"], "applied": True}:
            raise ValueError("vocabulary practice tool receipt")
        return {}

    async def correct(state: VocabularyPracticeState) -> dict[str, Any]:
        result = await call(
            "vocabulary-practice.correct",
            {
                "round": state["round"],
                "instruction": correction,
            },
        )
        if result != {"round": state["round"], "applied": True}:
            raise ValueError("vocabulary practice correction receipt")
        return {"corrections": state["corrections"] + 1, "kind": "corrected"}

    async def finish(state: VocabularyPracticeState) -> dict[str, Any]:
        reason = (
            "terminal"
            if state["kind"] == "complete"
            else "correction_limit"
            if state["corrections"] >= 2 and state["kind"] == "missing_marks"
            else "round_limit"
        )
        result = await call(
            "vocabulary-practice.finish", {"round": state["round"], "reason": reason}
        )
        if reason != "terminal" or result != {"completed": True, "rounds": state["round"]}:
            raise ValueError("vocabulary practice completion")
        return {"vocabularyPractice": result}

    def after_model(state: VocabularyPracticeState) -> str:
        if state["kind"] == "complete":
            return "finish"
        if state["kind"] == "missing_marks" and state["corrections"] >= 2:
            return "finish"
        return "apply" if state["kind"] == "tools" else "correct"

    graph = StateGraph(VocabularyPracticeState)
    for name, node in (
        ("prepare", prepare),
        ("model", model),
        ("apply", apply),
        ("correct", correct),
        ("finish", finish),
    ):
        graph.add_node(name, node)
    graph.add_edge(START, "prepare")
    graph.add_edge("prepare", "model")
    graph.add_conditional_edges("model", after_model)
    for name in ("apply", "correct"):
        graph.add_conditional_edges(name, lambda s: "finish" if s["round"] >= 8 else "model")
    graph.add_edge("finish", END)
    return cast(
        VocabularyPracticeState,
        await graph.compile().ainvoke(
            {"round": 0, "corrections": 0, "kind": "", "vocabularyPractice": {}},
            {"recursion_limit": budget["maxSteps"] + 1},
        ),
    )
