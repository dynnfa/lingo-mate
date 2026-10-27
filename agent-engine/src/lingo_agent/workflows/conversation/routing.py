"""Select a conversation workflow using only the latest user message."""

from typing import Any

from lingo_agent.state import LearningState
from lingo_agent.workflows.common import HostCall
from lingo_agent.workflows.conversation.concept import execute_concept
from lingo_agent.workflows.conversation.graph import execute_conversation

# Match ECMAScript trim()/\s, including BOM and excluding Python-only whitespace.
COMMAND_WHITESPACE = (
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003"
    "\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000"
    "\ufeff"
)


def is_word_concept_message(content: str) -> bool:
    content = content.strip(COMMAND_WHITESPACE)
    command = "/concept"
    return content.startswith(command) and (
        len(content) == len(command) or content[len(command)] in COMMAND_WHITESPACE
    )


async def execute_conversation_route(
    run_id: str, snapshot: dict[str, Any], host: HostCall
) -> LearningState:
    latest = snapshot["messages"][-1]
    if latest["role"] == "user" and is_word_concept_message(latest["content"]):
        return await execute_concept(run_id, snapshot, host)
    return await execute_conversation(run_id, snapshot, host)
