import json
from pathlib import Path

import pytest

from lingo_agent.protocol import parse_frame

CASES = json.loads(
    (Path(__file__).parents[4] / "tests/integration/fixtures/agent/protocol-cases.json").read_text()
)


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["name"])
def test_shared_wire_contract(case):
    data = json.dumps(case["frame"], ensure_ascii=False).encode()
    if case["valid"]:
        assert parse_frame(data) == case["frame"]
    else:
        with pytest.raises(Exception):
            parse_frame(data)


@pytest.mark.parametrize("data", [b"{bad", b"\xff", b"[]", b"x" * 262145])
def test_rejects_invalid_json_utf8_and_oversize(data):
    with pytest.raises(Exception):
        parse_frame(data)
