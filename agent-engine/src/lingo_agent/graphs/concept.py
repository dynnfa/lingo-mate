"""Single-call concept explanation, selected internally from conversation messages."""

from typing import Any, cast

from langgraph.graph import END, START, StateGraph

from lingo_agent.graphs.common import HostCall, check_input, initial_state, reply_update
from lingo_agent.prompts import word_concept_system_message
from lingo_agent.state import LearningState


async def execute_concept(run_id: str, snapshot: dict[str, Any], host: HostCall) -> LearningState:
    prompt = word_concept_system_message(snapshot["outputLanguage"], snapshot["targetLanguage"])
    check_input(snapshot, prompt)

    async def explain(state: LearningState) -> dict[str, Any]:
        return await reply_update(snapshot, state, prompt, host, "explain")

    graph = StateGraph(LearningState)
    graph.add_node("explain", explain)
    graph.add_edge(START, "explain")
    graph.add_edge("explain", END)
    return cast(
        LearningState,
        await graph.compile().ainvoke(
            initial_state(run_id, snapshot),
            # Allow the terminal superstep; reply_update enforces the operation budget.
            {"recursion_limit": max(2, snapshot["budget"]["maxSteps"])},
        ),
    )
