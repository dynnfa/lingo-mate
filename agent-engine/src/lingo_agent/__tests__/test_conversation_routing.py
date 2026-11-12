import pytest

from lingo_agent.runtime.dispatcher import execute


def snapshot(task: str):
    return {
        "task": task,
        "messages": [{"role": "user", "content": "/concept carry"}],
        "outputLanguage": "zh-CN",
        "targetLanguage": "en",
        "allowedOperations": ["model.reply"],
        "budget": {
            "timeoutMs": 1000,
            "maxModelCalls": 1,
            "maxToolCalls": 0,
            "maxSteps": 4,
            "maxInputChars": 8192,
            "maxOutputChars": 100,
        },
    }


async def test_routes_concept_through_host_and_preserves_languages():
    calls = []
    snapshot = {
        "task": "concept",
        "messages": [{"role": "user", "content": "/concept carry"}],
        "outputLanguage": "zh-CN",
        "targetLanguage": "en",
        "allowedOperations": ["model.reply"],
        "budget": {
            "timeoutMs": 1000,
            "maxModelCalls": 1,
            "maxToolCalls": 0,
            "maxSteps": 4,
            "maxInputChars": 8192,
            "maxOutputChars": 100,
        },
    }

    async def host(operation, args):
        calls.append((operation, args))
        return {"text": "answer"}

    state = await execute("run-1", snapshot, host)
    assert len(calls) == 1
    assert calls[0][0] == "model.reply"
    prompt = calls[0][1]["systemPrompt"]
    assert "the /concept command" in prompt
    assert "commentary on examples in Simplified Chinese (zh-CN)" in prompt
    assert "the example sentences themselves in English (en)" in prompt
    assert state["text"] == "answer"
    assert state["languages"] == {"outputLanguage": "zh-CN", "targetLanguage": "en"}
    assert state["status"] == "completed"


@pytest.mark.parametrize("task,step", [("conversation", "reply"), ("concept", "explain")])
async def test_reply_uses_bound_task_even_with_a_slash_command(task, step):
    async def host(operation, args):
        assert operation == "model.reply"
        return {"text": "answer"}

    state = await execute("reply", snapshot(task), host)
    assert state["step"] == step
