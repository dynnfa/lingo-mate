import asyncio
import os
import sys
import threading
import uuid
from typing import Any, cast

from langgraph.errors import GraphRecursionError

from lingo_agent.protocol import MAX_FRAME_BYTES, PROTOCOL_VERSION, encode_frame, parse_frame
from lingo_agent.runtime.dispatcher import execute
from lingo_agent.state import LearningState
from lingo_agent.workflows.common import LimitError
from lingo_agent.workflows.explore_phrase.graph import ExplorePhraseState
from lingo_agent.workflows.explore_vocabulary.graph import ExploreVocabularyState
from lingo_agent.workflows.phrase.graph import PhraseState
from lingo_agent.workflows.sentence_practice.graph import SentencePracticeState
from lingo_agent.workflows.synonym.graph import SynonymState
from lingo_agent.workflows.tts import TtsState
from lingo_agent.workflows.vocabulary.graph import VocabularyState
from lingo_agent.workflows.vocabulary_practice.graph import VocabularyPracticeState


class HostError(Exception):
    def __init__(self, code: str):
        self.code = code


class Server:
    def __init__(self) -> None:
        self.instance = ""
        self.runs: dict[str, asyncio.Task[None]] = {}
        self.retired: dict[str, None] = {}
        self.cancelling: set[str] = set()
        self.calls: dict[tuple[str, str], asyncio.Future[dict[str, Any]]] = {}
        self.sequences: dict[str, int] = {}
        self.chunk_sequences: dict[tuple[str, str], int] = {}
        self.write_lock = asyncio.Lock()
        self.pending_bytes = 0

    async def send(self, kind: str, **payload: Any) -> None:
        data = encode_frame(
            {"v": PROTOCOL_VERSION, "instanceId": self.instance, "type": kind, **payload}
        )
        self.pending_bytes += len(data)
        try:
            if self.pending_bytes > 1_048_576:
                raise ValueError("send queue limit")
            async with self.write_lock:

                def write() -> None:
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()

                await asyncio.to_thread(write)
        finally:
            self.pending_bytes -= len(data)

    async def host(self, run_id: str, operation: str, args: dict[str, Any]) -> dict[str, Any]:
        call_id = f"{run_id}:{uuid.uuid4()}"
        key = (run_id, call_id)
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self.calls[key] = future
        self.chunk_sequences[key] = 0
        try:
            await self.send(
                "host_call", runId=run_id, callId=call_id, operation=operation, args=args
            )
            return await future
        finally:
            self.calls.pop(key, None)
            self.chunk_sequences.pop(key, None)

    async def run(self, run_id: str, snapshot: dict[str, Any]) -> None:
        try:
            async with asyncio.timeout(snapshot["budget"]["timeoutMs"] / 1000):
                state = await execute(
                    run_id, snapshot, lambda op, args: self.host(run_id, op, args)
                )
                if snapshot["task"] == "tool-loop":
                    self.sequences[run_id] += 1
                    await self.send(
                        "event",
                        runId=run_id,
                        seq=self.sequences[run_id],
                        event={"type": "text", "delta": cast(LearningState, state)["text"]},
                    )
                if snapshot["task"] == "tts":
                    await self.send("tts_result", runId=run_id, result=cast(TtsState, state)["tts"])
                elif snapshot["task"] == "vocabulary-practice-review":
                    await self.send(
                        "vocabulary_practice_result",
                        runId=run_id,
                        result=cast(VocabularyPracticeState, state)["vocabularyPractice"],
                    )
                elif snapshot["task"] in ("sentence-practice-hints", "sentence-practice-review"):
                    await self.send(
                        "sentence_practice_result",
                        runId=run_id,
                        result=cast(SentencePracticeState, state)["sentencePractice"],
                    )
                elif snapshot["task"] == "explore-phrase":
                    await self.send(
                        "explore_phrase_result",
                        runId=run_id,
                        result=cast(ExplorePhraseState, state)["explorePhrase"],
                    )
                elif snapshot["task"] == "explore-vocabulary":
                    await self.send(
                        "explore_vocabulary_result",
                        runId=run_id,
                        result=cast(ExploreVocabularyState, state)["exploreVocabulary"],
                    )
                elif snapshot["task"] == "synonym":
                    await self.send(
                        "synonym_result", runId=run_id, result=cast(SynonymState, state)["synonym"]
                    )
                elif snapshot["task"] == "vocabulary":
                    await self.send(
                        "vocabulary_result",
                        runId=run_id,
                        result=cast(VocabularyState, state)["vocabulary"],
                    )
                elif snapshot["task"] == "phrase":
                    await self.send(
                        "phrase_result",
                        runId=run_id,
                        result=cast(PhraseState, state)["phrase"],
                    )
                else:
                    await self.send("result", runId=run_id, text=cast(LearningState, state)["text"])
        except asyncio.CancelledError:
            await self.send("cancelled", runId=run_id)
        except (TimeoutError, LimitError, GraphRecursionError):
            await self.send("error", runId=run_id, code="AGENT_LIMIT")
        except HostError as error:
            await self.send("error", runId=run_id, code=error.code)
        except Exception:
            # Tracebacks may contain user data; only stable codes cross the pipe.
            await self.send("error", runId=run_id, code="AGENT_PROTOCOL_ERROR")
        finally:
            self.runs.pop(run_id, None)
            self.sequences.pop(run_id, None)
            self.retired[run_id] = None
            self.cancelling.discard(run_id)
            if len(self.retired) > 128:
                self.retired.pop(next(iter(self.retired)))

    async def serve(self, incoming: asyncio.Queue[bytes | None]) -> None:
        try:
            first = await incoming.get()
            if first is None:
                return
            hello = parse_frame(first)
            if hello["type"] != "hello":
                raise ValueError("handshake required")
            self.instance = hello["instanceId"]
            await self.send(
                "ready",
                capabilities=[
                    "tts",
                    "vocabulary-practice-review",
                    "sentence-practice-hints",
                    "sentence-practice-review",
                    "conversation",
                    "conversation-title",
                    "tool-loop",
                    "vocabulary",
                    "phrase",
                    "synonym",
                    "explore-phrase",
                    "explore-vocabulary",
                ],
            )
            while (line := await incoming.get()) is not None:
                frame = parse_frame(line)
                if frame["instanceId"] != self.instance:
                    raise ValueError("instance mismatch")
                kind = frame["type"]
                if kind == "shutdown":
                    await self.stop()
                    await self.send("shutdown_ack")
                    return
                run_id = frame.get("runId", "")
                if kind == "run":
                    if run_id in self.runs or run_id in self.retired or len(self.runs) >= 8:
                        raise ValueError("run ownership or concurrency")
                    self.sequences[run_id] = 0
                    self.runs[run_id] = asyncio.create_task(self.run(run_id, frame["snapshot"]))
                elif kind == "cancel":
                    if run_id in self.runs:
                        self.cancelling.add(run_id)
                        self.runs[run_id].cancel()
                    elif run_id not in self.retired:
                        raise ValueError("unknown run")
                elif kind in ("host_result", "host_error", "host_chunk"):
                    if run_id in self.retired or run_id in self.cancelling:
                        continue
                    key = (run_id, frame["callId"])
                    future = self.calls.get(key)
                    if future is None or future.done():
                        raise ValueError("unknown or duplicate call")
                    if kind == "host_result":
                        future.set_result(frame["result"])
                    elif kind == "host_error":
                        future.set_exception(HostError(frame["code"]))
                    else:
                        if frame["seq"] != self.chunk_sequences[key] + 1:
                            raise ValueError("chunk sequence")
                        self.chunk_sequences[key] = frame["seq"]
                        self.sequences[run_id] += 1
                        await self.send(
                            "event", runId=run_id, seq=self.sequences[run_id], event=frame["event"]
                        )
                else:
                    raise ValueError("unexpected message")
        finally:
            await self.stop()

    async def stop(self) -> None:
        tasks = list(self.runs.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


async def main() -> None:
    if sys.platform == "win32":
        import msvcrt

        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    loop = asyncio.get_running_loop()
    incoming: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=128)

    def read() -> None:
        # An unbuffered OS read avoids a daemon thread holding stdin's buffered
        # lock during interpreter finalization while the parent pipe stays open.
        def put(item: bytes | None) -> None:
            asyncio.run_coroutine_threadsafe(incoming.put(item), loop).result(timeout=5)

        buffered = bytearray()
        try:
            while True:
                chunk = os.read(sys.stdin.fileno(), 65_536)
                if not chunk:
                    if buffered:
                        put(b"")  # an unterminated frame is a protocol failure
                    put(None)
                    return
                buffered.extend(chunk)
                while (end := buffered.find(b"\n")) >= 0:
                    put(bytes(buffered[:end]))
                    del buffered[: end + 1]
                if len(buffered) > MAX_FRAME_BYTES:
                    put(bytes(buffered))
                    return
        except Exception:
            return

    threading.Thread(target=read, name="agent-input", daemon=True).start()
    await Server().serve(incoming)
