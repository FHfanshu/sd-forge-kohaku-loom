from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, AsyncIterator


@dataclass
class BridgeRequest:
    request_id: str
    tool: str
    arguments: dict[str, Any]
    created_at: float
    future: asyncio.Future = field(repr=False)


class ForgeToolBroker:
    def __init__(self, event_limit: int = 1000):
        self._event_limit = max(10, event_limit)
        self._events: list[dict[str, Any]] = []
        self._pending: dict[str, BridgeRequest] = {}
        self._condition = asyncio.Condition()
        self._sequence = 0

    @property
    def sequence(self) -> int:
        return self._sequence

    async def request(self, tool: str, arguments: dict[str, Any], timeout: float = 300.0) -> dict[str, Any]:
        loop = asyncio.get_running_loop()
        request_id = uuid.uuid4().hex
        request = BridgeRequest(request_id, tool, dict(arguments), time.time(), loop.create_future())
        self._pending[request_id] = request
        await self._publish(
            "tool_request",
            {
                "request_id": request_id,
                "tool": tool,
                "arguments": request.arguments,
                "created_at": request.created_at,
            },
        )
        try:
            result = await asyncio.wait_for(asyncio.shield(request.future), timeout=max(1.0, timeout))
            return result if isinstance(result, dict) else {"ok": True, "result": result}
        except asyncio.TimeoutError as error:
            await self._publish("tool_timeout", {"request_id": request_id, "tool": tool})
            raise TimeoutError(f"Forge tool {tool!r} timed out") from error
        finally:
            self._pending.pop(request_id, None)

    async def reply(self, request_id: str, result: dict[str, Any]) -> str:
        request = self._pending.get(str(request_id or ""))
        if request is None:
            return "unknown"
        if request.future.done():
            return "superseded"
        request.future.set_result(dict(result))
        await self._publish(
            "tool_reply",
            {"request_id": request.request_id, "tool": request.tool, "ok": result.get("ok") is not False},
        )
        return "accepted"

    async def cancel_all(self, reason: str = "cancelled") -> None:
        for request in list(self._pending.values()):
            if not request.future.done():
                request.future.cancel(reason)
        await self._publish("bridge_cancelled", {"reason": reason})

    def events_after(self, sequence: int) -> list[dict[str, Any]]:
        return [dict(event) for event in self._events if int(event["sequence"]) > int(sequence)]

    async def subscribe(self, after_sequence: int = 0, keepalive: float = 15.0) -> AsyncIterator[dict[str, Any] | None]:
        cursor = int(after_sequence)
        while True:
            ready = self.events_after(cursor)
            if ready:
                for event in ready:
                    cursor = int(event["sequence"])
                    yield event
                continue
            try:
                async with self._condition:
                    await asyncio.wait_for(self._condition.wait(), timeout=max(1.0, keepalive))
            except asyncio.TimeoutError:
                yield None

    async def _publish(self, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        self._sequence += 1
        event = {
            "sequence": self._sequence,
            "type": event_type,
            "created_at": time.time(),
            "payload": payload,
        }
        self._events.append(event)
        if len(self._events) > self._event_limit:
            del self._events[: len(self._events) - self._event_limit]
        async with self._condition:
            self._condition.notify_all()
        return event


def encode_sse(event: dict[str, Any] | None) -> str:
    if event is None:
        return ": keepalive\n\n"
    return (
        f"id: {int(event['sequence'])}\n"
        f"event: {event['type']}\n"
        f"data: {json.dumps(event, ensure_ascii=False, separators=(',', ':'))}\n\n"
    )
