"""In-memory orchestration only; cloud tracing is always disabled."""

import os

os.environ["LANGCHAIN_TRACING_V2"] = "false"
os.environ["LANGSMITH_TRACING"] = "false"
os.environ["LANGSMITH_OTEL_ENABLED"] = "false"
