"""Independent, single-call conversation title generation."""

from typing import Any, cast

from langgraph.graph import END, START, StateGraph

from lingo_agent.state import LearningState
from lingo_agent.workflows.common import (
    HostCall,
    check_input,
    check_operation,
    check_output,
    initial_state,
)
from lingo_agent.workflows.conversation.prompts import conversation_title_system_message


async def execute_title(run_id: str, snapshot: dict[str, Any], host: HostCall) -> LearningState:
    prompt = conversation_title_system_message(snapshot["outputLanguage"])
    check_input(snapshot, prompt)

    async def generate(state: LearningState) -> dict[str, Any]:
        check_operation(snapshot, state, "model.title")
        result = await host("model.title", {"systemPrompt": prompt})
        check_output(snapshot, result["text"])
        return {
            "text": result["text"],
            "step": "generate",
            "steps": state["steps"] + 1,
            "modelCalls": state["modelCalls"] + 1,
            "status": "completed",
        }

    graph = StateGraph(LearningState)
    graph.add_node("generate", generate)
    graph.add_edge(START, "generate")
    graph.add_edge("generate", END)
    return cast(
        LearningState,
        await graph.compile().ainvoke(
            initial_state(run_id, snapshot),
            {"recursion_limit": max(2, snapshot["budget"]["maxSteps"])},
        ),
    )
