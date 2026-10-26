from typing import Any

import pytest

from lingo_agent.graphs.tts import execute_tts


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "receipt", [{}, {"completed": False}, {"completed": 1}, {"completed": True, "text": "private"}]
)
async def test_rejects_malformed_completion(receipt: dict[str, Any]) -> None:
    async def host(operation: str, args: dict[str, Any]) -> dict[str, Any]:
        assert operation == "tts.synthesize"
        assert args == {}
        return receipt

    with pytest.raises(ValueError):
        await execute_tts(
            {"allowedOperations": ["tts.synthesize"], "budget": {"maxModelCalls": 0}}, host
        )
