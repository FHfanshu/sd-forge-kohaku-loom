from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Callable

from kohaku_loom.forge_bridge import ForgeToolBroker
from kohaku_loom.profile_store import LoomProfileStore
from kohaku_loom.runtime_paths import LoomRuntimePaths


_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


class RuntimeEventLog:
    def __init__(self, limit: int = 2000, on_publish: Callable[[], None] | None = None):
        self._limit = max(20, limit)
        self._on_publish = on_publish
        self._events: list[dict[str, Any]] = []
        self._condition = asyncio.Condition()
        self._sequence = 0

    @property
    def sequence(self) -> int:
        return self._sequence

    async def publish(self, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        self._sequence += 1
        event = {
            "sequence": self._sequence,
            "type": event_type,
            "created_at": time.time(),
            "payload": json.loads(json.dumps(payload, ensure_ascii=False, default=str)),
        }
        self._events.append(event)
        if len(self._events) > self._limit:
            del self._events[: len(self._events) - self._limit]
        if self._on_publish is not None:
            self._on_publish()
        async with self._condition:
            self._condition.notify_all()
        return event

    def after(self, sequence: int) -> list[dict[str, Any]]:
        return [dict(event) for event in self._events if int(event["sequence"]) > int(sequence)]

    async def subscribe(self, sequence: int = 0, keepalive: float = 15.0) -> AsyncIterator[dict[str, Any] | None]:
        cursor = int(sequence)
        while True:
            events = self.after(cursor)
            if events:
                for event in events:
                    cursor = int(event["sequence"])
                    yield event
                continue
            try:
                async with self._condition:
                    await asyncio.wait_for(self._condition.wait(), timeout=max(1.0, keepalive))
            except asyncio.TimeoutError:
                yield None


@dataclass
class ActiveSession:
    session_id: str
    profile_id: str
    path: Path
    engine: Any
    creature: Any
    provider: Any
    resumed: bool
    opened_at: float


class LoomSidecarRuntime:
    def __init__(
        self,
        paths: LoomRuntimePaths,
        profiles: LoomProfileStore,
        broker: ForgeToolBroker,
        *,
        creature_ref: str | Path = "@kohaku-loom/creatures/loom",
        on_activity: Callable[[], None] | None = None,
    ):
        self.paths = paths.ensure()
        self.profiles = profiles
        self.broker = broker
        self.creature_ref = str(creature_ref)
        self.events = RuntimeEventLog(on_publish=on_activity)
        self.active: ActiveSession | None = None
        self._turn_task: asyncio.Task | None = None
        self._turn_id = ""
        self._lock = asyncio.Lock()

    @property
    def has_active_turn(self) -> bool:
        return self._turn_task is not None and not self._turn_task.done()

    def status(self) -> dict[str, Any]:
        session = self.active
        return {
            "active_session": self._session_payload(session) if session else None,
            "active_turn_id": self._turn_id if self.has_active_turn else "",
            "turn_event_sequence": self.events.sequence,
            "tool_event_sequence": self.broker.sequence,
        }

    def list_sessions(self) -> list[dict[str, Any]]:
        active_id = self.active.session_id if self.active else ""
        result = []
        for path in sorted(self.paths.sessions.glob("*.kohakutr"), key=lambda item: item.stat().st_mtime, reverse=True):
            stat = path.stat()
            result.append(
                {
                    "session_id": path.stem,
                    "path": str(path),
                    "size": stat.st_size,
                    "modified_at": stat.st_mtime,
                    "active": path.stem == active_id,
                }
            )
        return result

    def session_conversation(self, session_id: str) -> dict[str, Any]:
        session = self.active
        if session is None or session.session_id != self._validated_session_id(session_id):
            raise FileNotFoundError(session_id)
        conversation = session.creature.agent.controller.conversation
        messages = conversation.to_messages(preserve_pending_tail=True)
        return {
            "session": self._session_payload(session),
            "messages": json.loads(json.dumps(messages, ensure_ascii=False, default=str)),
        }

    async def open_session(
        self,
        profile_id: str,
        *,
        session_id: str = "",
        resume: bool = False,
        forge_bridge: bool = True,
        provider: Any = None,
    ) -> dict[str, Any]:
        async with self._lock:
            if self.active is not None:
                raise RuntimeError("A Loom session is already active")
            session_id = self._validated_session_id(session_id or uuid.uuid4().hex)
            path = self.paths.sessions / f"{session_id}.kohakutr"
            if resume and not path.is_file():
                raise FileNotFoundError(path)
            if not resume and path.exists():
                raise FileExistsError(path)
            resolved_provider = provider or self._build_provider(profile_id)
            try:
                engine, creature = await self._build_session(
                    resolved_provider,
                    path,
                    resume=resume,
                    forge_bridge=forge_bridge,
                )
            except BaseException:
                close = getattr(resolved_provider, "close", None)
                if callable(close):
                    await close()
                raise
            self.active = ActiveSession(
                session_id=session_id,
                profile_id=profile_id,
                path=path,
                engine=engine,
                creature=creature,
                provider=resolved_provider,
                resumed=resume,
                opened_at=time.time(),
            )
            payload = self._session_payload(self.active)
            await self.events.publish("session_opened", payload)
            return payload

    async def close_session(self) -> None:
        async with self._lock:
            session = self.active
            if session is None:
                return
            if self.has_active_turn:
                session.creature.agent.interrupt()
                try:
                    await asyncio.wait_for(asyncio.shield(self._turn_task), timeout=15)
                except (asyncio.CancelledError, asyncio.TimeoutError):
                    if self._turn_task is not None:
                        self._turn_task.cancel()
                        await asyncio.gather(self._turn_task, return_exceptions=True)
            self.active = None
            self._turn_task = None
            self._turn_id = ""
            await session.engine.shutdown()
            await self.broker.cancel_all("session_closed")
            await self.events.publish("session_closed", {"session_id": session.session_id})

    async def start_turn(self, content: Any, timeout: float | None = None) -> dict[str, Any]:
        async with self._lock:
            if self.active is None:
                raise RuntimeError("No Loom session is active")
            if self.has_active_turn:
                raise RuntimeError("A Loom turn is already active")
            if not isinstance(content, (str, list)) or not content:
                raise ValueError("content must be a non-empty string or content-part list")
            turn_id = uuid.uuid4().hex
            self._turn_id = turn_id
            self._turn_task = asyncio.create_task(
                self._run_turn(self.active, turn_id, content, timeout),
                name=f"loom-turn-{turn_id}",
            )
            return {"turn_id": turn_id, "status": "accepted"}

    async def profile_chat(self, profile_id: str, messages: list[dict[str, Any]]) -> dict[str, Any]:
        if not isinstance(messages, list) or not messages:
            raise ValueError("messages must be a non-empty list")
        provider = self._build_provider(profile_id)
        begin_turn = getattr(provider, "begin_turn", None)
        end_turn = getattr(provider, "end_turn", None)
        try:
            if callable(begin_turn):
                await begin_turn()
            response = await provider.chat_complete(messages)
            return {
                "ok": True,
                "text": response.content,
                "model": response.model or getattr(provider.config, "model", ""),
                "usage": response.usage or dict(getattr(provider, "last_usage", {}) or {}),
            }
        finally:
            if callable(end_turn):
                await end_turn()
            await provider.close()

    async def cancel_turn(self, turn_id: str) -> str:
        async with self._lock:
            if not self.has_active_turn or turn_id != self._turn_id or self.active is None:
                return "unknown"
            self.active.creature.agent.interrupt()
            await self.events.publish("turn_cancel_requested", {"turn_id": turn_id})
            return "accepted"

    async def close(self) -> None:
        await self.close_session()

    async def _build_session(self, provider: Any, path: Path, *, resume: bool, forge_bridge: bool):
        from kohakuterrarium import Terrarium
        from kohakuterrarium.terrarium.drive.config import DriveRuntimeConfig
        from kohaku_loom.forge_tools import forge_tools

        drive_config = DriveRuntimeConfig(enabled=False)
        tools = forge_tools(self.broker) if forge_bridge else []
        if resume:
            engine = await Terrarium.resume(
                str(path),
                pwd=str(self.paths.root.parent),
                llm=provider,
                drive_config=drive_config,
            )
            creatures = engine.list_creatures()
            if len(creatures) != 1:
                await engine.shutdown()
                raise RuntimeError("Loom sessions must contain exactly one creature")
            creature = creatures[0]
            for tool in tools:
                creature.agent.add_tool(tool)
        else:
            engine = Terrarium(
                pwd=str(self.paths.root.parent),
                session_dir=str(self.paths.sessions),
                drive_config=drive_config,
            )
            try:
                creature = await engine.add_creature(
                    self.creature_ref,
                    creature_id="loom",
                    llm=provider,
                    io="headless",
                    strict=True,
                    session=path,
                    tools=tools,
                    start=False,
                )
                await engine.start(creature)
            except BaseException:
                await engine.shutdown()
                raise
        await creature.wait_restoration_ready()
        return engine, creature

    def _build_provider(self, profile_id: str):
        from kohaku_loom.kt_providers import build_profile_provider

        return build_profile_provider(self.profiles.resolve(profile_id))

    async def _run_turn(
        self,
        session: ActiveSession,
        turn_id: str,
        content: Any,
        timeout: float | None,
    ) -> None:
        from kohakuterrarium import Activity, TextChunk, TurnEnded
        from kohaku_loom.response_text import reasoning_text

        begin_turn = getattr(session.provider, "begin_turn", None)
        end_turn = getattr(session.provider, "end_turn", None)
        set_stream_observer = getattr(session.provider, "set_stream_observer", None)

        async def observe(event_type: str, payload: dict[str, Any]) -> None:
            await self.events.publish(event_type, {"turn_id": turn_id, **payload})

        try:
            if callable(set_stream_observer):
                set_stream_observer(observe)
            if callable(begin_turn):
                await begin_turn()
            await self.events.publish(
                "turn_started",
                {"turn_id": turn_id, "session_id": session.session_id},
            )
            async for event in session.creature.run_stream(
                content,
                timeout=timeout,
                source="kohaku-loom",
            ):
                if isinstance(event, TextChunk):
                    await self.events.publish("text_delta", {"turn_id": turn_id, "text": event.text})
                elif isinstance(event, Activity):
                    if event.kind in {"token_usage", "turn_token_usage"} and event.metadata:
                        await self.events.publish(
                            "usage",
                            {"turn_id": turn_id, "usage": event.metadata},
                        )
                    await self.events.publish(
                        "activity",
                        {
                            "turn_id": turn_id,
                            "kind": event.kind,
                            "detail": event.detail,
                            "metadata": event.metadata,
                        },
                    )
                elif isinstance(event, TurnEnded):
                    result = event.result
                    final_reasoning = reasoning_text(
                        getattr(session.provider, "last_assistant_extra_fields", {})
                    )
                    if final_reasoning:
                        await self.events.publish(
                            "reasoning_snapshot",
                            {"turn_id": turn_id, "text": final_reasoning},
                        )
                    if result.usage:
                        await self.events.publish(
                            "usage",
                            {"turn_id": turn_id, "usage": result.usage},
                        )
                    await self.events.publish(
                        "turn_ended",
                        {
                            "turn_id": turn_id,
                            "status": result.status,
                            "text": result.text,
                            "error": result.error,
                            "usage": result.usage,
                            "duration_s": result.duration_s,
                            "interrupted_by_user": result.interrupted_by_user,
                        },
                    )
        except asyncio.CancelledError:
            await self.events.publish("turn_ended", {"turn_id": turn_id, "status": "interrupted"})
            raise
        except Exception as error:
            await self.events.publish(
                "turn_ended",
                {"turn_id": turn_id, "status": "error", "error": str(error)},
            )
        finally:
            if callable(set_stream_observer):
                set_stream_observer(None)
            if callable(end_turn):
                await end_turn()
            if self._turn_id == turn_id:
                self._turn_id = ""

    @staticmethod
    def _validated_session_id(value: str) -> str:
        value = str(value or "").strip()
        if not _SESSION_ID_RE.fullmatch(value):
            raise ValueError("session_id must contain only letters, numbers, dot, underscore, or hyphen")
        return value

    @staticmethod
    def _session_payload(session: ActiveSession) -> dict[str, Any]:
        return {
            "session_id": session.session_id,
            "profile_id": session.profile_id,
            "path": str(session.path),
            "resumed": session.resumed,
            "opened_at": session.opened_at,
        }
