"""Sequential, host-bound synonym tool loop. No learning data lives in the graph."""

import json
from typing import Any, TypedDict, cast

from langgraph.graph import END, START, StateGraph

from lingo_agent.workflows.common import HostCall, LimitError, chars
from lingo_agent.workflows.synonym.prompts import synonym_system_message

OPERATIONS = {"synonym.prepare", "model.synonym", "synonym.apply", "synonym.finish"}


class SynonymState(TypedDict):
    items: list[int]
    position: int
    round: int
    decision: str
    reason: str
    corrected: bool
    synonym: dict[str, list[int]]


async def execute_synonym(snapshot: dict[str, Any], host: HostCall) -> SynonymState:
    if set(snapshot["allowedOperations"]) != OPERATIONS:
        raise ValueError("synonym operations")
    budget = snapshot["budget"]
    prompt = synonym_system_message(snapshot["outputLanguage"])
    if chars(prompt) > 4096 or chars(prompt) > budget["maxInputChars"]:
        raise LimitError()
    models = tools = steps = output = 0

    async def call(op: str, args: dict[str, Any]) -> dict[str, Any]:
        nonlocal models, tools, steps, output
        steps += 1
        if op == "model.synonym":
            models += 1
        else:
            tools += 1
        if (
            steps > budget["maxSteps"]
            or models > budget["maxModelCalls"]
            or tools > budget["maxToolCalls"]
        ):
            raise LimitError()
        result = await host(op, args)
        output += chars(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        if output > budget["maxOutputChars"]:
            raise LimitError()
        if "inputIndex" in args and result.get("inputIndex") != args["inputIndex"]:
            raise ValueError("synonym index ownership")
        if "round" in args and op != "synonym.finish" and result.get("round") != args["round"]:
            raise ValueError("synonym round ownership")
        return result

    async def prepare(state: SynonymState) -> dict[str, Any]:
        result = await call("synonym.prepare", {})
        items = result["items"]
        if not 1 <= len(items) <= 20 or any(
            item["inputIndex"] != i or item["status"] not in ("pending", "resolved")
            for i, item in enumerate(items)
        ):
            raise ValueError("synonym prepared items")
        return {"items": [i["inputIndex"] for i in items if i["status"] == "pending"]}

    async def select(state: SynonymState) -> dict[str, Any]:
        return {"round": 0, "corrected": False}

    async def decide(state: SynonymState) -> dict[str, Any]:
        round_ = state["round"] + 1
        result = await call(
            "model.synonym",
            {
                "inputIndex": state["items"][state["position"]],
                "round": round_,
                "systemPrompt": prompt,
            },
        )
        if result.get("inputChars", 0) > budget["maxInputChars"]:
            raise LimitError()
        kind = result["kind"]
        if kind not in ("tool", "parallel", "failed"):
            raise ValueError("synonym model decision")
        return {"round": round_, "decision": kind, "reason": "failed"}

    async def apply(state: SynonymState) -> dict[str, Any]:
        correction = state["decision"] == "parallel"
        if correction and state["corrected"]:
            # The host refuses a second correction too; fail without executing any call.
            return {"reason": "failed", "decision": "finish"}
        result = await call(
            "synonym.apply",
            {
                "inputIndex": state["items"][state["position"]],
                "round": state["round"],
                "action": "reject_parallel" if correction else "execute",
            },
        )
        kind = result["kind"]
        if kind not in ("continue", "terminal", "failed"):
            raise ValueError("synonym tool decision")
        return {
            "corrected": state["corrected"] or correction,
            "decision": "continue" if kind == "continue" and state["round"] < 52 else "finish",
            "reason": "round_limit" if kind == "continue" else kind,
        }

    async def finish(state: SynonymState) -> dict[str, Any]:
        index = state["items"][state["position"]]
        result = await call(
            "synonym.finish",
            {
                "inputIndex": index,
                "round": state["round"],
                "reason": state["reason"],
            },
        )
        done = [*state["synonym"]["completedIndices"], index]
        position = state["position"] + 1
        if result["stop"]:
            done.extend(state["items"][position:])
            position = len(state["items"])
        return {"position": position, "synonym": {"completedIndices": done}}

    graph = StateGraph(SynonymState)
    for name, node in (
        ("prepare", prepare),
        ("select", select),
        ("decide", decide),
        ("apply", apply),
        ("finish", finish),
    ):
        graph.add_node(name, node)
    graph.add_edge(START, "prepare")

    def next_word(state: SynonymState) -> str:
        return "select" if state["position"] < len(state["items"]) else END

    graph.add_conditional_edges("prepare", next_word)
    graph.add_edge("select", "decide")
    graph.add_conditional_edges(
        "decide", lambda s: "finish" if s["decision"] == "failed" else "apply"
    )
    graph.add_conditional_edges(
        "apply", lambda s: "decide" if s["decision"] == "continue" else "finish"
    )
    graph.add_conditional_edges("finish", next_word)
    return cast(
        SynonymState,
        await graph.compile().ainvoke(
            {
                "items": [],
                "position": 0,
                "round": 0,
                "decision": "",
                "reason": "",
                "corrected": False,
                "synonym": {"completedIndices": []},
            },
            {"recursion_limit": budget["maxSteps"] + 42},
        ),
    )
