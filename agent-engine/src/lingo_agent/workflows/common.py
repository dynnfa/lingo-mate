"""Shared graph state, host boundary checks and bounded reply execution."""

from collections.abc import Awaitable, Callable
from typing import Any

from lingo_agent.state import LearningState

HostCall = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]


class LimitError(Exception):
    pass


def chars(text: str) -> int:
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2


def check_input(snapshot: dict[str, Any], prompt: str, reserved_chars: int = 0) -> int:
    if chars(prompt) > 4096:
        raise LimitError()
    size = (
        sum(chars(message["content"]) for message in snapshot["messages"])
        + chars(prompt)
        + reserved_chars
    )
    if size > snapshot["budget"]["maxInputChars"]:
        raise LimitError()
    return size


def check_operation(snapshot: dict[str, Any], state: LearningState, operation: str) -> None:
    if operation not in snapshot["allowedOperations"]:
        raise ValueError("operation not allowed")
    budget = snapshot["budget"]
    if state["steps"] >= budget["maxSteps"]:
        raise LimitError()
    if operation.startswith("model.") and state["modelCalls"] >= budget["maxModelCalls"]:
        raise LimitError()
    if operation == "learning.lookup" and state["toolCount"] >= budget["maxToolCalls"]:
        raise LimitError()


def check_output(snapshot: dict[str, Any], text: str) -> None:
    if chars(text) > snapshot["budget"]["maxOutputChars"]:
        raise LimitError()


async def reply_update(
    snapshot: dict[str, Any], state: LearningState, prompt: str, host: HostCall, step: str
) -> dict[str, Any]:
    check_operation(snapshot, state, "model.reply")
    result = await host("model.reply", {"systemPrompt": prompt})
    check_output(snapshot, result["text"])
    return {
        "text": result["text"],
        "step": step,
        "steps": state["steps"] + 1,
        "modelCalls": state["modelCalls"] + 1,
        "status": "completed",
    }


def initial_state(run_id: str, snapshot: dict[str, Any]) -> LearningState:
    return {
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
