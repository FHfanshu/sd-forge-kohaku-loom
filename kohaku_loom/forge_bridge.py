from __future__ import annotations

import asyncio
import hashlib
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
    operation_id: str = ""
    fingerprint: str = ""
    bridge_id: str = ""


class ForgeToolBroker:
    def __init__(self, event_limit: int = 1000):
        self._event_limit = max(10, event_limit)
        self._events: list[dict[str, Any]] = []
        self._pending: dict[str, BridgeRequest] = {}
        self._pending_by_fingerprint: dict[str, BridgeRequest] = {}
        self._condition = asyncio.Condition()
        self._sequence = 0
        self._operation_sequence = 0
        self._session_id = ""
        self._turn_id = ""
        self._bridge_id = ""
        self._bridge_seen_at = 0.0

    @property
    def sequence(self) -> int:
        return self._sequence

    def begin_session(self, session_id: str) -> None:
        self._session_id = str(session_id or "")
        self._turn_id = ""
        self._operation_sequence = 0
        self._pending_by_fingerprint.clear()

    def end_session(self) -> None:
        self._session_id = ""
        self._turn_id = ""
        self._operation_sequence = 0
        self._pending_by_fingerprint.clear()

    def begin_turn(self, turn_id: str) -> None:
        self._turn_id = str(turn_id or "")
        self._operation_sequence = 0

    async def claim_bridge(self, bridge_id: str, lease_seconds: float = 10.0) -> dict[str, Any]:
        bridge_id = str(bridge_id or "").strip()
        if not bridge_id:
            raise ValueError("bridge_id is required")
        now = time.monotonic()
        owned = not self._bridge_id or self._bridge_id == bridge_id or now - self._bridge_seen_at >= lease_seconds
        if owned:
            changed = self._bridge_id != bridge_id
            self._bridge_id = bridge_id
            self._bridge_seen_at = now
            if changed:
                for request in self._pending.values():
                    if request.future.done():
                        continue
                    request.bridge_id = bridge_id
                    await self._publish("tool_request", self._request_payload(request))
        return {"owned": owned, "bridge_id": self._bridge_id, "pending_requests": self.pending_requests()}

    async def release_bridge(self, bridge_id: str) -> bool:
        if self._bridge_id != str(bridge_id or ""):
            return False
        self._bridge_id = ""
        self._bridge_seen_at = 0.0
        return True

    async def request(self, tool: str, arguments: dict[str, Any], timeout: float = 300.0) -> dict[str, Any]:
        safe_arguments = dict(arguments)
        fingerprint = self._mutation_fingerprint(tool, safe_arguments)
        if fingerprint and fingerprint in self._pending_by_fingerprint:
            existing = self._pending_by_fingerprint[fingerprint]
            result = await asyncio.wait_for(asyncio.shield(existing.future), timeout=max(1.0, timeout))
            return result if isinstance(result, dict) else {"ok": True, "result": result}
        loop = asyncio.get_running_loop()
        request_id = uuid.uuid4().hex
        self._operation_sequence += 1
        operation_id = f"{self._turn_id or self._session_id or 'session'}:{self._operation_sequence}"
        request = BridgeRequest(
            request_id,
            tool,
            safe_arguments,
            time.time(),
            loop.create_future(),
            operation_id,
            fingerprint,
            self._bridge_id,
        )
        self._pending[request_id] = request
        if fingerprint:
            self._pending_by_fingerprint[fingerprint] = request
        await self._publish(
            "tool_request",
            self._request_payload(request),
        )
        try:
            result = await asyncio.wait_for(asyncio.shield(request.future), timeout=max(1.0, timeout))
            normalized = result if isinstance(result, dict) else {"ok": True, "result": result}
            return normalized
        except asyncio.TimeoutError as error:
            await self._publish("tool_timeout", {"request_id": request_id, "tool": tool})
            raise TimeoutError(f"Forge tool {tool!r} timed out") from error
        finally:
            self._pending.pop(request_id, None)
            if fingerprint and self._pending_by_fingerprint.get(fingerprint) is request:
                self._pending_by_fingerprint.pop(fingerprint, None)

    async def reply(self, request_id: str, result: dict[str, Any], bridge_id: str = "") -> str:
        request = self._pending.get(str(request_id or ""))
        if request is None:
            return "unknown"
        if request.bridge_id and request.bridge_id != str(bridge_id or ""):
            return "foreign"
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

    @staticmethod
    def _mutation_fingerprint(tool: str, arguments: dict[str, Any]) -> str:
        action = str(arguments.get("action") or "")
        if tool not in {"edit_prompt", "initialize_prompt", "apply_txt2img_patch"} and not (
            tool == "forge_resource" and action == "apply"
        ):
            return ""
        context_hash = str(
            arguments.get("base_hash")
            or arguments.get("context_hash")
            or arguments.get("state_hash")
            or arguments.get("prompt_hash")
            or ""
        )
        if not context_hash:
            return ""
        public_arguments = {key: value for key, value in arguments.items() if not str(key).startswith("_")}
        payload = json.dumps(
            {"tool": tool, "arguments": public_arguments, "context_hash": context_hash},
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def events_after(self, sequence: int) -> list[dict[str, Any]]:
        return [dict(event) for event in self._events if int(event["sequence"]) > int(sequence)]

    def pending_requests(self) -> list[dict[str, Any]]:
        return [
            {
                "request_id": request.request_id,
                "tool": request.tool,
                "arguments": {
                    key: value for key, value in request.arguments.items() if not str(key).startswith("_")
                },
                "created_at": request.created_at,
                "operation_id": request.operation_id,
                "fingerprint": request.fingerprint,
                "bridge_id": request.bridge_id,
                "agent_mode": "yolo" if request.arguments.get("_yolo_authorized") is True else "normal",
            }
            for request in self._pending.values()
            if not request.future.done()
        ]

    @staticmethod
    def _request_payload(request: BridgeRequest) -> dict[str, Any]:
        arguments = {key: value for key, value in request.arguments.items() if not str(key).startswith("_")}
        return {
            "request_id": request.request_id,
            "tool": request.tool,
            "arguments": arguments,
            "created_at": request.created_at,
            "operation_id": request.operation_id,
            "fingerprint": request.fingerprint,
            "bridge_id": request.bridge_id,
            "agent_mode": "yolo" if request.arguments.get("_yolo_authorized") is True else "normal",
        }

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
