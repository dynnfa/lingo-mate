"""Bounded tool loop for the explicitly authorized test extension."""

import json
from typing import Any, cast

from langgraph.graph import END, START, StateGraph

from lingo_agent.state import LearningState
from lingo_agent.workflows.common import (
    HostCall,
    LimitError,
    chars,
    check_input,
    check_operation,
    check_output,
    initial_state,
)


async def execute_tool_loop(run_id: str, snapshot: dict[str, Any], host: HostCall) -> LearningState:
    budget = snapshot["budget"]
    context_size = check_input(snapshot, "", reserved_chars=4096)

    async def decide(state: LearningState) -> dict[str, Any]:
        check_operation(snapshot, state, "model.decide")
        result = await host("model.decide", {"results": state["toolResults"]})
        update: dict[str, Any] = {
            "step": "decide",
            "steps": state["steps"] + 1,
            "modelCalls": state["modelCalls"] + 1,
        }
        if result["kind"] == "final":
            check_output(snapshot, result["text"])
            update.update(text=result["text"], status="completed", next="end")
        elif result["kind"] == "tool" and result["name"] == "learning.lookup":
            update.update(toolCalls=[*state["toolCalls"], result], next="tool")
        else:
            raise ValueError("unknown decision or tool")
        return update

    async def tool(state: LearningState) -> dict[str, Any]:
        check_operation(snapshot, state, "learning.lookup")
        call = state["toolCalls"][-1]
        result = await host("learning.lookup", {"query": call["query"]})
        results = [*state["toolResults"], result]
        if (
            context_size + chars(json.dumps(results, ensure_ascii=False, separators=(",", ":")))
            > budget["maxInputChars"]
        ):
            raise LimitError()
        return {
            "toolResults": results,
            "toolCount": state["toolCount"] + 1,
            "steps": state["steps"] + 1,
            "step": "tool",
        }

    graph = StateGraph(LearningState)
    graph.add_node("decide", decide)
    graph.add_node("tool", tool)
    graph.add_edge(START, "decide")
    graph.add_conditional_edges("decide", lambda state: END if state["next"] == "end" else "tool")
    graph.add_edge("tool", "decide")
    return cast(
        LearningState,
        await graph.compile().ainvoke(
            initial_state(run_id, snapshot),
            {"recursion_limit": max(2, budget["maxSteps"])},
        ),
    )
