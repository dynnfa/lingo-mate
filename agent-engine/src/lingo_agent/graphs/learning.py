from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any, cast

if TYPE_CHECKING:
    from lingo_agent.graphs.vocabulary import VocabularyState

from langgraph.graph import END, START, StateGraph

from lingo_agent.prompts import (
    conversation_system_message,
    is_word_concept_message,
    word_concept_system_message,
)
from lingo_agent.state import LearningState

HostCall = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]


class LimitError(Exception):
    pass


async def execute(
    run_id: str, snapshot: dict[str, Any], host: HostCall
) -> LearningState | VocabularyState:
    if snapshot["task"] == "vocabulary":
        from lingo_agent.graphs.vocabulary import execute_vocabulary

        return await execute_vocabulary(snapshot, host)
    budget = snapshot["budget"]

    def chars(text: str) -> int:
        return len(text.encode("utf-16-le", errors="surrogatepass")) // 2

    system_prompt = ""
    if snapshot["task"] != "tool-loop":
        latest = snapshot["messages"][-1]
        system_prompt = (
            word_concept_system_message
            if latest["role"] == "user" and is_word_concept_message(latest["content"])
            else conversation_system_message
        )(snapshot["outputLanguage"], snapshot["targetLanguage"])
        if chars(system_prompt) > 4096:
            raise LimitError()
    context_size = sum(chars(m["content"]) for m in snapshot["messages"]) + (
        4096 if snapshot["task"] == "tool-loop" else chars(system_prompt)
    )
    if context_size > budget["maxInputChars"]:
        raise LimitError()

    def check(state: LearningState, operation: str) -> None:
        if operation not in snapshot["allowedOperations"]:
            raise ValueError("operation not allowed")
        if state["steps"] >= budget["maxSteps"]:
            raise LimitError()
        if operation.startswith("model.") and state["modelCalls"] >= budget["maxModelCalls"]:
            raise LimitError()
        if operation == "learning.lookup" and state["toolCount"] >= budget["maxToolCalls"]:
            raise LimitError()

    async def reply(state: LearningState) -> dict[str, Any]:
        check(state, "model.reply")
        result = await host("model.reply", {"systemPrompt": system_prompt})
        if chars(result["text"]) > budget["maxOutputChars"]:
            raise LimitError()
        return {
            "text": result["text"],
            "step": "reply",
            "steps": state["steps"] + 1,
            "modelCalls": 1,
            "status": "completed",
        }

    async def decide(state: LearningState) -> dict[str, Any]:
        check(state, "model.decide")
        result = await host("model.decide", {"results": state["toolResults"]})
        update: dict[str, Any] = {
            "step": "decide",
            "steps": state["steps"] + 1,
            "modelCalls": state["modelCalls"] + 1,
        }
        if result["kind"] == "final":
            if chars(result["text"]) > budget["maxOutputChars"]:
                raise LimitError()
            update.update(text=result["text"], status="completed", next="end")
        elif result["kind"] == "tool" and result["name"] == "learning.lookup":
            update.update(toolCalls=[*state["toolCalls"], result], next="tool")
        else:
            raise ValueError("unknown decision or tool")
        return update

    async def tool(state: LearningState) -> dict[str, Any]:
        check(state, "learning.lookup")
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
    initial: LearningState = {
        "version": 1,
        "runId": run_id,
        "task": snapshot["task"],
        "languages": {
            "outputLanguage": snapshot["outputLanguage"],
            "targetLanguage": snapshot["targetLanguage"],
        },
        "step": "start",
        "messages": snapshot["messages"],
        "toolCalls": [],
        "toolResults": [],
        "steps": 0,
        "modelCalls": 0,
        "toolCount": 0,
        "status": "running",
        "text": "",
        "next": "",
    }
    return cast(
        LearningState,
        await graph.compile().ainvoke(initial, {"recursion_limit": budget["maxSteps"]}),
    )
