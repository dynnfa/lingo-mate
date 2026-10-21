from typing import Any, TypedDict


class LearningState(TypedDict):
    version: int
    runId: str
    task: str
    languages: dict[str, str]
    step: str
    messages: list[dict[str, str]]
    toolCalls: list[dict[str, Any]]
    toolResults: list[dict[str, Any]]
    steps: int
    modelCalls: int
    toolCount: int
    status: str
    text: str
    next: str
