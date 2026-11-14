"""Select one workflow using the current request and its admitted scope."""

from typing import Any, Literal, TypedDict, cast

from langgraph.graph import END, START, StateGraph

from lingo_agent.workflows.common import HostCall, LimitError, chars
from lingo_agent.workflows.conversation.prompts import conversation_intent_system_message

# None means the workflow accepts either a bare command or an argument.
COMMANDS: dict[str, bool | None] = {
    "concept": None,
    "vocabulary": True,
    "phrase": True,
    "synonym": True,
    "explore-phrase": False,
    "explore-vocabulary": False,
    "sentence": True,
    "tts": True,
}
RESTRICTED_COMMANDS = {"channel-chat": (), "channel-sentence": ("sentence",), "retry": ("concept",)}
CLASSIFY = "model.classify-conversation"


class ReplyRoute(TypedDict):
    kind: Literal["reply"]


class WorkflowRoute(TypedDict):
    kind: Literal["workflow", "invalid"]
    workflow: str


class ConversationRouteState(TypedDict):
    route: ReplyRoute | WorkflowRoute | None


async def execute_conversation_route(
    snapshot: dict[str, Any], host: HostCall
) -> ConversationRouteState:
    async def route(state: ConversationRouteState) -> ConversationRouteState:
        request = snapshot["route"]
        command, mode = request["command"], request["mode"]
        if command in COMMANDS and (mode == "desktop" or command in RESTRICTED_COMMANDS[mode]):
            required = COMMANDS[command]
            kind: Literal["workflow", "invalid"] = (
                "workflow" if required is None or required == request["hasArguments"] else "invalid"
            )
            return {"route": {"kind": kind, "workflow": command}}
        if command is None and mode == "desktop":
            if CLASSIFY not in snapshot["allowedOperations"]:
                raise ValueError("operation not allowed")
            budget = snapshot["budget"]
            prompt = conversation_intent_system_message(
                snapshot["outputLanguage"], snapshot["targetLanguage"]
            )
            if (
                budget["maxSteps"] < 1
                or budget["maxModelCalls"] < 1
                or chars(prompt) > 4096
                or chars(prompt) + snapshot["inputChars"] > budget["maxInputChars"]
            ):
                raise LimitError()
            receipt = await host(CLASSIFY, {"systemPrompt": prompt})
            if receipt == {"intent": "concept"}:
                return {"route": {"kind": "workflow", "workflow": "concept"}}
            if receipt not in ({"intent": "reply"}, {"intent": "unclear"}):
                raise ValueError("invalid classification receipt")
        return {"route": {"kind": "reply"}}

    graph = StateGraph(ConversationRouteState)
    graph.add_node("route_request", route)
    graph.add_edge(START, "route_request")
    graph.add_edge("route_request", END)
    return cast(
        ConversationRouteState,
        await graph.compile().ainvoke(
            {"route": None}, {"recursion_limit": snapshot["budget"]["maxSteps"] + 1}
        ),
    )
