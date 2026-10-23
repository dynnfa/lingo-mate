from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, cast

if TYPE_CHECKING:
    from lingo_agent.graphs.explore_phrase import ExplorePhraseState
    from lingo_agent.graphs.phrase import PhraseState
    from lingo_agent.graphs.synonym import SynonymState
    from lingo_agent.graphs.vocabulary import VocabularyState

from langgraph.graph import END, START, StateGraph

from lingo_agent.graphs.common import (
    HostCall,
    LimitError,
    chars,
    check_input,
    check_operation,
    check_output,
    initial_state,
    reply_update,
)
from lingo_agent.prompts import conversation_system_message, is_word_concept_message
from lingo_agent.state import LearningState


async def execute(
    run_id: str, snapshot: dict[str, Any], host: HostCall
) -> LearningState | VocabularyState | PhraseState | SynonymState | ExplorePhraseState:
    if snapshot["task"] == "explore-phrase":
        from lingo_agent.graphs.explore_phrase import execute_explore_phrase

        return await execute_explore_phrase(snapshot, host)
    if snapshot["task"] == "synonym":
        from lingo_agent.graphs.synonym import execute_synonym

        return await execute_synonym(snapshot, host)
    if snapshot["task"] == "phrase":
        from lingo_agent.graphs.phrase import execute_phrase

        return await execute_phrase(snapshot, host)
    if snapshot["task"] == "vocabulary":
        from lingo_agent.graphs.vocabulary import execute_vocabulary

        return await execute_vocabulary(snapshot, host)
    if snapshot["task"] == "conversation":
        latest = snapshot["messages"][-1]
        if latest["role"] == "user" and is_word_concept_message(latest["content"]):
            from lingo_agent.graphs.concept import execute_concept

            return await execute_concept(run_id, snapshot, host)
    budget = snapshot["budget"]
    system_prompt = ""
    if snapshot["task"] != "tool-loop":
        system_prompt = conversation_system_message(
            snapshot["outputLanguage"], snapshot["targetLanguage"]
        )
    context_size = check_input(
        snapshot, system_prompt, reserved_chars=4096 if snapshot["task"] == "tool-loop" else 0
    )

    async def reply(state: LearningState) -> dict[str, Any]:
        return await reply_update(snapshot, state, system_prompt, host, "reply")

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
    graph.add_node("reply", reply)
    graph.add_node("decide", decide)
    graph.add_node("tool", tool)
    graph.add_conditional_edges(
        START, lambda state: "decide" if state["task"] == "tool-loop" else "reply"
    )
    graph.add_edge("reply", END)
    graph.add_conditional_edges("decide", lambda state: END if state["next"] == "end" else "tool")
    graph.add_edge("tool", "decide")
    return cast(
        LearningState,
        await graph.compile().ainvoke(
            # A one-node reply also needs its terminal superstep.
            initial_state(run_id, snapshot),
            {"recursion_limit": max(2, budget["maxSteps"])},
        ),
    )
