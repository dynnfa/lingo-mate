import json
from pathlib import Path
from typing import Any, cast

from jsonschema import Draft202012Validator

MAX_FRAME_BYTES = 262_144
PROTOCOL_VERSION = 2
_validator = Draft202012Validator(json.loads(Path(__file__).with_name("schema.json").read_text()))


def _validate_frame(frame: Any) -> None:
    _validator.validate(frame)
    # JSON Schema maxLength uses code points; enforce the wire's UTF-16 budget too.
    if frame["type"] == "host_call" and frame["operation"] == "model.reply":
        prompt = frame["args"]["systemPrompt"]
        if len(prompt.encode("utf-16-le", errors="surrogatepass")) // 2 > 4096:
            raise ValueError("system prompt limit")


def parse_frame(data: bytes) -> dict[str, Any]:
    if len(data) > MAX_FRAME_BYTES:
        raise ValueError("frame limit")
    frame = json.loads(data.decode("utf-8"))
    _validate_frame(frame)
    return cast(dict[str, Any], frame)


def encode_frame(frame: dict[str, Any]) -> bytes:
    _validate_frame(frame)
    data = json.dumps(frame, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(data) > MAX_FRAME_BYTES:
        raise ValueError("frame limit")
    return data + b"\n"
