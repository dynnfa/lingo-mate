import json
from pathlib import Path
from typing import Any, cast

from jsonschema import Draft202012Validator

MAX_FRAME_BYTES = 262_144
PROTOCOL_VERSION = 1
_validator = Draft202012Validator(json.loads(Path(__file__).with_name("schema.json").read_text()))


def parse_frame(data: bytes) -> dict[str, Any]:
    if len(data) > MAX_FRAME_BYTES:
        raise ValueError("frame limit")
    frame = json.loads(data.decode("utf-8"))
    _validator.validate(frame)
    return cast(dict[str, Any], frame)


def encode_frame(frame: dict[str, Any]) -> bytes:
    _validator.validate(frame)
    data = json.dumps(frame, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(data) > MAX_FRAME_BYTES:
        raise ValueError("frame limit")
    return data + b"\n"
