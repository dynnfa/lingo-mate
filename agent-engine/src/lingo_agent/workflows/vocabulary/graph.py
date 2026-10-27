import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any, TypedDict, cast

from langgraph.graph import END, START, StateGraph

from lingo_agent.workflows.common import LimitError
from lingo_agent.workflows.vocabulary.prompts import vocabulary_system_message


class VocabularyState(TypedDict):
    items: list[dict[str, Any]]
    vocabulary: dict[str, list[int]]
    text: str
    modelCalls: int
    steps: int


async def execute_vocabulary(
    snapshot: dict[str, Any],
    host: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]],
) -> VocabularyState:
    budget = snapshot["budget"]
    if set(snapshot["allowedOperations"]) != {"vocabulary.prepare", "model.vocabulary"}:
        raise ValueError("vocabulary operations")
    prompt = vocabulary_system_message(snapshot["outputLanguage"])
    prompt_chars = len(prompt.encode("utf-16-le")) // 2
    if prompt_chars > 4096:
        raise LimitError()

    async def prepare(state: VocabularyState) -> dict[str, Any]:
        if budget["maxToolCalls"] < 1 or budget["maxSteps"] < 2:
            raise LimitError()
        result = await host("vocabulary.prepare", {})
        return {"items": result["items"], "steps": 1}

    async def analyze(state: VocabularyState) -> dict[str, Any]:
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
                    prompt_chars + len(item["term"].encode("utf-16-le")) // 2 + 4096
                    > budget["maxInputChars"]
                ):
                    raise LimitError()
                result = await host(
                    "model.vocabulary", {"inputIndex": item["inputIndex"], "systemPrompt": prompt}
                )
                if result["inputIndex"] != item["inputIndex"]:
                    raise ValueError("vocabulary result ownership")
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
            "vocabulary": {"completedIndices": sorted(completed)},
            "modelCalls": len(completed),
            "steps": state["steps"] + len(completed),
        }

    def finalize(state: VocabularyState) -> dict[str, Any]:
        return {"steps": state["steps"] + 1}

    graph = StateGraph(VocabularyState)
    graph.add_node("prepare", prepare)
    graph.add_node("analyze", analyze)
    graph.add_node("finalize", finalize)
    graph.add_edge(START, "prepare")
    graph.add_edge("prepare", "analyze")
    graph.add_edge("analyze", "finalize")
    graph.add_edge("finalize", END)
    return cast(
        VocabularyState,
        await graph.compile().ainvoke(
            {
                "items": [],
                "vocabulary": {"completedIndices": []},
                "text": "",
                "modelCalls": 0,
                "steps": 0,
            },
            {"recursion_limit": budget["maxSteps"]},
        ),
    )
