import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any, TypedDict, cast

from langgraph.graph import END, START, StateGraph

from lingo_agent.graphs.learning import LimitError
from lingo_agent.prompts import phrase_system_message


class PhraseState(TypedDict):
    items: list[dict[str, Any]]
    phrase: dict[str, list[int]]
    text: str
    modelCalls: int
    steps: int


async def execute_phrase(
    snapshot: dict[str, Any],
    host: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]],
) -> PhraseState:
    budget = snapshot["budget"]
    if set(snapshot["allowedOperations"]) != {"phrase.prepare", "model.phrase"}:
        raise ValueError("phrase operations")
    prompt = phrase_system_message(snapshot["outputLanguage"])
    prompt_chars = len(prompt.encode("utf-16-le")) // 2
    if prompt_chars > 4096:
        raise LimitError()

    async def prepare(state: PhraseState) -> dict[str, Any]:
        if budget["maxToolCalls"] < 1 or budget["maxSteps"] < 2:
            raise LimitError()
        result = await host("phrase.prepare", {})
        return {"items": result["items"], "steps": 1}

    async def analyze(state: PhraseState) -> dict[str, Any]:
        candidates = [item for item in state["items"] if item["status"] == "pending"]
        if len(candidates) > budget["maxModelCalls"] or len(candidates) + 2 > budget["maxSteps"]:
            raise LimitError()
        # Host enforces the analysis deadline and returns TIMEOUT without calling
        # the provider for unstarted items. Every candidate is accounted for once.
        next_index = 0
        completed = []
        output_chars = 0

        async def worker() -> None:
            nonlocal next_index, output_chars
            while next_index < len(candidates):
                item = candidates[next_index]
                next_index += 1
                if (
                    prompt_chars + len(item["phrase"].encode("utf-16-le")) // 2 + 4096
                    > budget["maxInputChars"]
                ):
                    raise LimitError()
                result = await host(
                    "model.phrase", {"inputIndex": item["inputIndex"], "systemPrompt": prompt}
                )
                if result["inputIndex"] != item["inputIndex"]:
                    raise ValueError("phrase result ownership")
                output_chars += len(json.dumps(result, ensure_ascii=False).encode("utf-16-le")) // 2
                completed.append(item["inputIndex"])

        # TaskGroup cancels the sibling on fatal errors, never leaving an orphan
        # model call or allowing a successful final marker after a host failure.
        try:
            async with asyncio.TaskGroup() as group:
                group.create_task(worker())
                group.create_task(worker())
        except ExceptionGroup as errors:
            # TaskGroup has already cancelled/joined siblings. Preserve the first
            # fatal error's type so the server retains its stable wire error code.
            raise errors.exceptions[0] from errors
        if output_chars > budget["maxOutputChars"]:
            raise LimitError()
        return {
            "phrase": {"completedIndices": sorted(completed)},
            "modelCalls": len(completed),
            "steps": state["steps"] + len(completed),
        }

    def finalize(state: PhraseState) -> dict[str, Any]:
        return {"steps": state["steps"] + 1}

    graph = StateGraph(PhraseState)
    graph.add_node("prepare", prepare)
    graph.add_node("analyze", analyze)
    graph.add_node("finalize", finalize)
    graph.add_edge(START, "prepare")
    graph.add_edge("prepare", "analyze")
    graph.add_edge("analyze", "finalize")
    graph.add_edge("finalize", END)
    return cast(
        PhraseState,
        await graph.compile().ainvoke(
            {
                "items": [],
                "phrase": {"completedIndices": []},
                "text": "",
                "modelCalls": 0,
                "steps": 0,
            },
            {"recursion_limit": budget["maxSteps"]},
        ),
    )
