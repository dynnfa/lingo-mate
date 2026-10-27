"""Single-call ordinary conversation."""

from typing import Any, cast

from langgraph.graph import END, START, StateGraph

from lingo_agent.state import LearningState
from lingo_agent.workflows.common import HostCall, check_input, initial_state, reply_update
from lingo_agent.workflows.conversation.prompts import conversation_system_message


async def execute_conversation(
    run_id: str, snapshot: dict[str, Any], host: HostCall
) -> LearningState:
    system_prompt = conversation_system_message(
        snapshot["outputLanguage"], snapshot["targetLanguage"]
    )
    check_input(snapshot, system_prompt)

    async def reply(state: LearningState) -> dict[str, Any]:
        return await reply_update(snapshot, state, system_prompt, host, "reply")

    graph = StateGraph(LearningState)
    graph.add_node("reply", reply)
    graph.add_edge(START, "reply")
    graph.add_edge("reply", END)
    return cast(
        LearningState,
        await graph.compile().ainvoke(
            initial_state(run_id, snapshot),
            # Allow the terminal superstep; reply_update enforces the operation budget.
            {"recursion_limit": max(2, snapshot["budget"]["maxSteps"])},
        ),
    )
