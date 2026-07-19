from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from kohaku_loom.forge_bridge import ForgeToolBroker
from kohaku_loom.profile_store import LoomProfileStore
from kohaku_loom.runtime_paths import LoomRuntimePaths
from kohaku_loom.sidecar import branch_runtime
from kohaku_loom.sidecar.event_log import RuntimeEventLog
from kohaku_loom.sidecar.message_queue import LoomMessageQueue
from kohaku_loom.sidecar.session_metadata import SessionMetadataQueue, metadata_payload, read_metadata, source_messages


_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_LOOM_SKILL_NAMES = {"danbooru-prompting"}


def restrict_agent_skills(agent: Any) -> bool:
    """Keep unrelated project/user skills out of this Forge-only agent prompt."""
    registry = getattr(agent, "skills", None)
    if registry is None or not callable(getattr(registry, "list_enabled", None)):
        return False
    changed = False
    for skill in registry.list_enabled():
        if str(getattr(skill, "name", "")) not in _LOOM_SKILL_NAMES:
            skill.enabled = False
            changed = True
    if changed:
        refresh = getattr(agent, "refresh_system_prompt", None)
        if callable(refresh):
            refresh()
    return changed


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
    forge_bridge: bool = True
    branch_view: dict[int, int] | None = None


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
        self._active_message_id = ""
        self._guide_count_for_turn = 0
        self._paused = False
        self._cancel_requested = False
        self._turn_snapshot: dict[str, Any] = {}
        self._queued_primary_for_turn = False
        self._drain_task: asyncio.Task | None = None
        self._lock = asyncio.Lock()
        self._guide_lock = asyncio.Lock()
        self._metadata = SessionMetadataQueue(
            self._naming_profile,
            self._metadata_messages,
            self._session_path,
            lambda: self.has_active_turn,
            self.events.publish,
        )

    @property
    def has_active_turn(self) -> bool:
        return self._turn_task is not None and not self._turn_task.done()

    def status(self) -> dict[str, Any]:
        session = self.active
        queue = self._queue(session) if session else None
        branches = self._branch_payload(session) if session else {}
        turn_active = self.has_active_turn and not self._turn_snapshot.get("terminal")
        turn_settling = self.has_active_turn and bool(self._turn_snapshot.get("terminal"))
        return {
            "active_session": self._session_payload(session) if session else None,
            "active_turn_id": self._turn_id if turn_active else "",
            "settling_turn_id": self._turn_id if turn_settling else "",
            "active_turn": dict(self._turn_snapshot) if turn_active else None,
            "last_turn": dict(self._turn_snapshot) if self._turn_snapshot else None,
            "queue_paused": self._paused,
            "messages": queue.active() if queue else [],
            "recent_operations": queue.operations() if queue else [],
            "token_usage": self._token_usage(session),
            "pending_tool_requests": self.broker.pending_requests(),
            "turn_event_sequence": self.events.sequence,
            "tool_event_sequence": self.broker.sequence,
            "branch_view": branches.get("branch_view", {}),
            "branch_counts": branches.get("branch_counts", {}),
            "selected_branch_ids": branches.get("selected_branch_ids", {}),
            "branches": branches,
        }

    def list_sessions(self) -> list[dict[str, Any]]:
        active_id = self.active.session_id if self.active else ""
        result = []
        for path in sorted(self.paths.sessions.glob("*.kohakutr"), key=lambda item: item.stat().st_mtime, reverse=True):
            stat = path.stat()
            metadata = metadata_payload(path.stem, path)
            # A session can be restored from an older file before its first
            # metadata sidecar exists. Once it is active, the conversation is
            # available and the normal async naming queue can safely backfill
            # the title without blocking the history request.
            if path.stem == active_id and metadata["status"] == "pending":
                try:
                    asyncio.get_running_loop()
                except RuntimeError:
                    # Synchronous callers (for example an offline indexer)
                    # cannot own an asyncio metadata task.
                    pass
                else:
                    try:
                        self.session_metadata(path.stem)
                    except (RuntimeError, OSError, ValueError):
                        pass
                metadata = metadata_payload(path.stem, path)
            result.append({
                "session_id": path.stem,
                "path": str(path),
                "size": stat.st_size,
                "modified_at": stat.st_mtime,
                "active": path.stem == active_id,
                **metadata,
            })
        return result

    def session_conversation(self, session_id: str) -> dict[str, Any]:
        session = self.active
        if session is None or session.session_id != self._validated_session_id(session_id):
            raise FileNotFoundError(session_id)
        conversation = session.creature.agent.controller.conversation
        messages = conversation.to_messages(preserve_pending_tail=True)
        queue = self._queue(session)
        return {
            "session": self._session_payload(session),
            "messages": json.loads(json.dumps(messages, ensure_ascii=False, default=str)),
            "queue": queue.active(),
            "token_usage": self._token_usage(session),
            "branches": self._branch_payload(session),
        }

    def session_metadata(self, session_id: str, *, refresh: bool = False) -> dict[str, Any]:
        path = self._session_path(session_id)
        if not path.is_file():
            raise FileNotFoundError(session_id)
        return self._metadata.schedule(session_id, force=refresh)

    async def open_session(
        self,
        profile_id: str,
        *,
        session_id: str = "",
        resume: bool = False,
        forge_bridge: bool = True,
        agent_mode: str = "normal",
        provider: Any = None,
    ) -> dict[str, Any]:
        async with self._lock:
            if self.active is not None:
                raise RuntimeError("A Loom session is already active")
            session_id = self._validated_session_id(session_id or uuid.uuid4().hex)
            del agent_mode
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
                forge_bridge=forge_bridge,
                branch_view={},
            )
            self.broker.begin_session(session_id)
            queue = self._queue(self.active)
            recovered = queue.recover_interrupted()
            self._paused = bool(recovered) or queue.has_failed_primary()
            branches = branch_runtime.restore(self, self.active)
            payload = {**self._session_payload(self.active), "branches": branches}
            await self.events.publish("session_opened", payload)
            if recovered:
                await self.events.publish(
                    "queue_recovered",
                    {"session_id": session_id, "messages": recovered, "paused": True},
                )
            elif queue.next_primary() is not None:
                self._schedule_drain()
            if resume:
                self.session_metadata(session_id)
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
            self._active_message_id = ""
            self._guide_count_for_turn = 0
            self._turn_snapshot = {}
            if self._drain_task is not None:
                self._drain_task.cancel()
                await asyncio.gather(self._drain_task, return_exceptions=True)
                self._drain_task = None
            await session.engine.shutdown()
            await self.broker.cancel_all("session_closed")
            self.broker.end_session()
            await self.events.publish("session_closed", {"session_id": session.session_id})

    async def start_turn(
        self,
        content: Any,
        timeout: float | None = None,
        operation_id: str = "",
    ) -> dict[str, Any]:
        async with self._lock:
            if self.active is None:
                raise RuntimeError("No Loom session is active")
            if operation_id and self._turn_snapshot.get("operation_id") == operation_id:
                return {
                    "turn_id": self._turn_snapshot["turn_id"],
                    "status": "accepted",
                    "message_id": self._active_message_id,
                    "operation_id": operation_id,
                }
            if self.has_active_turn:
                raise RuntimeError("A Loom turn is already active")
            if not isinstance(content, (str, list)) or not content:
                raise ValueError("content must be a non-empty string or content-part list")
            if self._queue(self.active).next_primary() is not None:
                raise RuntimeError("A queued Loom message must be resumed before starting a new turn")
            self._metadata.interrupt()
            self._paused = False
            self._resume_agent(self.active)
            return self._launch_turn(self.active, content, timeout, operation_id=operation_id)

    async def enqueue_message(
        self,
        session_id: str,
        content: Any,
        *,
        display_content: str = "",
        attachments: list[dict[str, Any]] | None = None,
        operation_id: str = "",
    ) -> dict[str, Any]:
        async with self._lock:
            session = self._active_session(session_id)
            if not isinstance(content, (str, list)) or not content:
                raise ValueError("content must be a non-empty string or content-part list")
            queue = self._queue(session)
            existing = queue.by_operation(operation_id)
            if existing is not None:
                return existing
            kind = "primary"
            if self.has_active_turn and self._queued_primary_for_turn and self._guide_count_for_turn < 5:
                kind = "guide"
            guide_turn_id = self._turn_id if kind == "guide" else ""
            item = queue.enqueue(
                content,
                kind=kind,
                display_content=display_content,
                attachments=attachments,
                turn_id=guide_turn_id,
                operation_id=operation_id,
            )
            await self.events.publish("message_queued", {"session_id": session_id, "message": item})
            if kind == "guide":
                self._guide_count_for_turn += 1
                item = await self._inject_guide(session, item, guide_turn_id)
            else:
                if self.has_active_turn:
                    self._queued_primary_for_turn = True
                elif not self._paused:
                    self._schedule_drain()
            return item

    async def edit_message(
        self,
        session_id: str,
        message_id: str,
        content: Any,
        *,
        display_content: str = "",
        attachments: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        async with self._lock:
            session = self._active_session(session_id)
            queue = self._queue(session)
            current = queue.get(message_id)
            if current["state"] == "guide_waiting" and not session.creature.agent.edit_pending(message_id, content):
                raise RuntimeError("message is already claimed")
            item = queue.edit(message_id, content, display_content, attachments)
            await self.events.publish("message_updated", {"session_id": session_id, "message": item})
            return item

    async def cancel_message(self, session_id: str, message_id: str) -> dict[str, Any]:
        async with self._lock:
            session = self._active_session(session_id)
            queue = self._queue(session)
            current = queue.get(message_id)
            if current["state"] == "guide_waiting" and not session.creature.agent.cancel_pending(message_id):
                raise RuntimeError("message is already claimed")
            item = queue.cancel(message_id)
            if self.has_active_turn and queue.pending_primary_count() == 0:
                self._queued_primary_for_turn = False
            await self.events.publish("message_updated", {"session_id": session_id, "message": item})
            return item

    async def retry_message(self, session_id: str, message_id: str) -> dict[str, Any]:
        async with self._lock:
            session = self._active_session(session_id)
            if self.has_active_turn:
                raise RuntimeError("A Loom turn is already active")
            queue = self._queue(session)
            item = queue.get(message_id)
            head = queue.next_primary()
            if item.get("kind") != "primary" or item.get("state") not in {"pending", "failed"}:
                raise RuntimeError("only a pending or failed primary message can be resumed")
            if head is None or head.get("message_id") != message_id:
                raise RuntimeError("only the queue head can be resumed")
            if item.get("state") == "pending" and not self._paused:
                raise RuntimeError("the queue is already running")
            if item.get("state") == "failed":
                item = queue.mark(message_id, "pending", error="")
            self._paused = False
            self._resume_agent(session)
            self._schedule_drain()
            await self.events.publish("queue_resumed", {"session_id": session_id})
            return item

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

    def branch_metadata(self, session_id: str) -> dict[str, Any]:
        return branch_runtime.metadata(self, session_id)

    async def select_branch_view(self, session_id: str, branch_view: Any) -> dict[str, Any]:
        return await branch_runtime.select(self, session_id, branch_view)

    async def replay_branch_view(self, session_id: str, branch_view: Any = None) -> dict[str, Any]:
        return await branch_runtime.replay(self, session_id, branch_view)

    async def regenerate_last_response(self, session_id: str, operation_id: str = "") -> dict[str, Any]:
        return await branch_runtime.regenerate(self, session_id, operation_id)

    async def edit_and_rerun_message(self, session_id: str, content: Any, turn_index: int, user_position: int, operation_id: str = "") -> dict[str, Any]:
        return await branch_runtime.edit_and_rerun(self, session_id, content, turn_index, user_position, operation_id)

    async def cancel_turn(self, turn_id: str) -> str:
        async with self._lock:
            if not self.has_active_turn or turn_id != self._turn_id or self.active is None:
                return "unknown"
            if self._turn_snapshot.get("terminal") is not None:
                return "unknown"
            self._cancel_requested = True
            self.active.creature.agent.interrupt()
            await self.broker.cancel_all("turn_cancelled")
            await self.events.publish("turn_cancel_requested", {"turn_id": turn_id})
            return "accepted"

    async def close(self) -> None:
        await self.close_session()
        await self._metadata.close()

    async def _build_session(self, provider: Any, path: Path, *, resume: bool, forge_bridge: bool):
        from kohakuterrarium import Terrarium
        from kohakuterrarium.terrarium.drive.config import DriveRuntimeConfig
        from kohaku_loom.sidecar.prompt_edit_guard import build_prompt_edit_guard
        from kohaku_loom.sidecar.tool_disclosure import initial_tools

        drive_config = DriveRuntimeConfig(enabled=False)
        tools = initial_tools(self.broker, forge_bridge=forge_bridge)
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
            await creature.agent.add_plugin(build_prompt_edit_guard())
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
                    plugins=[build_prompt_edit_guard()],
                    start=False,
                )
                await engine.start(creature)
            except BaseException:
                await engine.shutdown()
                raise
        await creature.wait_restoration_ready()
        restrict_agent_skills(creature.agent)
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
        terminal: dict[str, Any] = {"status": "error", "error": "turn ended without a terminal result"}

        async def observe(event_type: str, payload: dict[str, Any]) -> None:
            if event_type == "provider_retry":
                self._turn_snapshot["retry"] = dict(payload)
            elif event_type == "reasoning_delta":
                self._turn_snapshot["reasoning"] = str(self._turn_snapshot.get("reasoning") or "") + str(
                    payload.get("text") or ""
                )
            elif event_type == "reasoning_snapshot":
                self._turn_snapshot["reasoning"] = str(payload.get("text") or "")
            elif event_type == "usage":
                self._turn_snapshot["usage"] = payload.get("usage") or payload
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
                    self._turn_snapshot["text"] += event.text
                    await self.events.publish("text_delta", {"turn_id": turn_id, "text": event.text})
                elif isinstance(event, Activity):
                    if event.kind == "user_input_injected":
                        await self._claim_next_guide(session, turn_id)
                    if event.kind == "processing_end":
                        self._pause_agent(session)
                    if event.kind in {"token_usage", "turn_token_usage"} and event.metadata:
                        self._turn_snapshot["usage"] = event.metadata
                        await self.events.publish(
                            "usage",
                            {
                                "turn_id": turn_id,
                                "usage": event.metadata,
                                "session_usage": self._token_usage(session),
                            },
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
                    terminal = {
                        "turn_id": turn_id,
                        "status": result.status,
                        "text": result.text,
                        "error": result.error,
                        "usage": result.usage,
                        "duration_s": result.duration_s,
                        "interrupted_by_user": result.interrupted_by_user,
                        "session_usage": self._token_usage(session),
                    }
                    self._turn_snapshot["terminal"] = dict(terminal)
                    final_reasoning = reasoning_text(
                        getattr(session.provider, "last_assistant_extra_fields", {})
                    )
                    if final_reasoning:
                        self._turn_snapshot["reasoning"] = final_reasoning
                        await self.events.publish(
                            "reasoning_snapshot",
                            {"turn_id": turn_id, "text": final_reasoning},
                        )
                    if result.usage:
                        await self.events.publish(
                            "usage",
                            {"turn_id": turn_id, "usage": result.usage},
                        )
                    await self.events.publish("turn_ended", terminal)
                    break
        except asyncio.CancelledError:
            terminal = {"turn_id": turn_id, "status": "interrupted", "error": "turn task cancelled"}
            self._turn_snapshot["terminal"] = dict(terminal)
            await self.events.publish("turn_ended", terminal)
            raise
        except Exception as error:
            terminal = {"turn_id": turn_id, "status": "error", "error": str(error)}
            self._turn_snapshot["terminal"] = dict(terminal)
            await self.events.publish(
                "turn_ended",
                terminal,
            )
        finally:
            cleanup_errors = []
            try:
                if callable(set_stream_observer):
                    set_stream_observer(None)
            except Exception as error:
                cleanup_errors.append(f"stream observer cleanup: {error}")
            try:
                if callable(end_turn):
                    await end_turn()
            except Exception as error:
                cleanup_errors.append(f"provider cleanup: {error}")
            try:
                if cleanup_errors:
                    await self.events.publish(
                        "provider_cleanup_error",
                        {"turn_id": turn_id, "error": "; ".join(cleanup_errors)},
                    )
                await self._settle_turn(session, turn_id, terminal)
            finally:
                if self._turn_id == turn_id:
                    self._turn_id = ""
                self._cancel_requested = False
                if str(terminal.get("status") or "").lower() in {"ok", "completed"}:
                    path = self._session_path(session.session_id)
                    if path.is_file() and metadata_payload(session.session_id, path)["status"] != "completed":
                        self.session_metadata(session.session_id)

    def _launch_turn(
        self,
        session: ActiveSession,
        content: Any,
        timeout: float | None,
        *,
        message_id: str = "",
        operation_id: str = "",
    ) -> dict[str, Any]:
        turn_id = uuid.uuid4().hex
        self._turn_id = turn_id
        self.broker.begin_turn(turn_id)
        self._active_message_id = message_id
        self._queued_primary_for_turn = False
        self._guide_count_for_turn = 0
        self._turn_snapshot = {
            "turn_id": turn_id,
            "session_id": session.session_id,
            "text": "",
            "reasoning": "",
            "usage": None,
            "retry": None,
            "terminal": None,
            "operation_id": str(operation_id or ""),
        }
        self._turn_task = asyncio.create_task(
            self._run_turn(session, turn_id, content, timeout),
            name=f"loom-turn-{turn_id}",
        )
        return {
            "turn_id": turn_id,
            "status": "accepted",
            "message_id": message_id,
            "operation_id": str(operation_id or ""),
        }

    async def _inject_guide(
        self,
        session: ActiveSession,
        item: dict[str, Any],
        turn_id: str,
    ) -> dict[str, Any]:
        async with self._guide_lock:
            queue = self._queue(session)
            current = queue.get(item["message_id"])
            if current.get("state") != "guide_waiting" or current.get("turn_id") != turn_id:
                return current
            try:
                processed = await session.creature.agent.inject_input(
                    current["content"],
                    source="kohaku-loom-guide",
                    pending_id=current["message_id"],
                )
            except Exception as error:
                converted = queue.mark(
                    current["message_id"],
                    "pending",
                    kind="primary",
                    turn_id="",
                    error=f"Live guidance injection failed: {error}",
                )
                await self.events.publish(
                    "message_updated",
                    {"session_id": session.session_id, "message": converted},
                )
                return converted
            if not processed:
                return queue.get(current["message_id"])
            claimed = queue.mark(
                current["message_id"],
                "claimed",
                turn_id=turn_id,
                claimed_at=time.time(),
            )
            await self.events.publish("message_updated", {"session_id": session.session_id, "message": claimed})
            return claimed

    async def _claim_next_guide(self, session: ActiveSession, turn_id: str) -> None:
        async with self._guide_lock:
            queue = self._queue(session)
            current = next(
                (item for item in queue.waiting_guides() if item.get("turn_id") == turn_id),
                None,
            )
            if current is None:
                return
            claimed = queue.mark(
                current["message_id"],
                "claimed",
                turn_id=turn_id,
                claimed_at=time.time(),
            )
            await self.events.publish("message_updated", {"session_id": session.session_id, "message": claimed})

    async def _settle_turn(
        self,
        session: ActiveSession,
        turn_id: str,
        terminal: dict[str, Any],
    ) -> None:
        async with self._lock:
            await self._settle_turn_locked(session, turn_id, terminal)

    async def _settle_turn_locked(
        self,
        session: ActiveSession,
        turn_id: str,
        terminal: dict[str, Any],
    ) -> None:
        try:
            queue = self._queue(session)
        except RuntimeError:
            if str(terminal.get("status") or "").lower() not in {"ok", "completed"}:
                self._paused = True
            return
        successful = str(terminal.get("status") or "").lower() in {"ok", "completed"}
        interrupted = bool(terminal.get("interrupted_by_user"))
        if self._active_message_id:
            target = "delivered" if successful and not self._cancel_requested and not interrupted else "failed"
            error = terminal.get("error") or ("cancelled" if self._cancel_requested or interrupted else terminal.get("status") or "failed")
            item = queue.mark(
                self._active_message_id,
                target,
                turn_id=turn_id,
                error="" if target == "delivered" else str(error),
            )
            await self.events.publish("message_updated", {"session_id": session.session_id, "message": item})
        self._active_message_id = ""

        async with self._guide_lock:
            for waiting in queue.waiting_guides():
                if waiting.get("turn_id") != turn_id:
                    continue
                if session.creature.agent.cancel_pending(waiting["message_id"]):
                    converted = queue.mark(waiting["message_id"], "pending", kind="primary", turn_id="")
                    await self.events.publish(
                        "message_updated",
                        {"session_id": session.session_id, "message": converted},
                    )
                else:
                    claimed = queue.mark(
                        waiting["message_id"],
                        "claimed",
                        turn_id=turn_id,
                        claimed_at=time.time(),
                    )
                    await self.events.publish(
                        "message_updated",
                        {"session_id": session.session_id, "message": claimed},
                    )

            guide_success = successful and not self._cancel_requested and not interrupted
            for claimed in queue.list():
                if claimed.get("kind") != "guide" or claimed.get("state") != "claimed" or claimed.get("turn_id") != turn_id:
                    continue
                settled = queue.mark(
                    claimed["message_id"],
                    "delivered" if guide_success else "failed",
                    kind="guide" if guide_success else "primary",
                    error="" if guide_success else str(terminal.get("error") or terminal.get("status") or "failed"),
                )
                await self.events.publish("message_updated", {"session_id": session.session_id, "message": settled})

        if successful and not self._cancel_requested and not interrupted:
            self._paused = False
            self._resume_agent(session)
            self._schedule_drain()
        else:
            self._paused = True
            self._pause_agent(session)
            await self.events.publish(
                "queue_paused",
                {"session_id": session.session_id, "turn_id": turn_id, "reason": terminal.get("status")},
            )

    def _schedule_drain(self) -> None:
        if self._drain_task is not None and not self._drain_task.done():
            if self._drain_task is not asyncio.current_task():
                return
        self._drain_task = asyncio.create_task(self._drain_next(), name="loom-queue-drain")

    async def _drain_next(self) -> None:
        while self.has_active_turn:
            await asyncio.sleep(0)
        async with self._lock:
            session = self.active
            if session is None or self.has_active_turn or self._paused:
                return
            queue = self._queue(session)
            item = queue.next_primary()
            if item is None:
                return
            if item.get("state") == "failed":
                self._paused = True
                self._pause_agent(session)
                await self.events.publish(
                    "queue_paused",
                    {"session_id": session.session_id, "reason": "failed_head", "message_id": item["message_id"]},
                )
                return
            self._metadata.interrupt()
            self._resume_agent(session)
            accepted = self._launch_turn(session, item["content"], None, message_id=item["message_id"])
            item = queue.mark(
                item["message_id"],
                "running",
                error="",
                turn_id=accepted["turn_id"],
                claimed_at=time.time(),
            )
            await self.events.publish(
                "message_updated",
                {"session_id": session.session_id, "message": item, "turn_id": accepted["turn_id"]},
            )

    def _queue(self, session: ActiveSession) -> LoomMessageQueue:
        store = getattr(session.creature.agent, "session_store", None)
        if store is None:
            raise RuntimeError("KohakuTerrarium session store is unavailable")
        return LoomMessageQueue(store, str(session.creature.agent.config.name))

    def _branch_payload(self, session: ActiveSession) -> dict[str, Any]:
        try:
            return branch_runtime.metadata(self, session.session_id)
        except (FileNotFoundError, ImportError, ModuleNotFoundError, RuntimeError, TypeError, ValueError):
            view = getattr(session, "branch_view", {})
            return {
                "session_id": session.session_id,
                "branch_view": dict(view) if isinstance(view, dict) else {},
            }

    def _naming_profile(self) -> dict[str, Any]:
        state = self.profiles.list_state()
        profile_id = str(state.get("naming_profile_id") or "").strip()
        if not profile_id:
            raise RuntimeError("请先在模型设置中选择会话命名模型")
        profile = self.profiles.resolve(profile_id)
        if profile.get("runtime") != "llama-once":
            raise RuntimeError("会话命名模型必须是已启用的 llama-once 配置")
        return profile

    def _metadata_messages(self, session_id: str) -> list[dict[str, Any]]:
        session = self.active
        if session is not None and session.session_id == session_id:
            return json.loads(json.dumps(
                session.creature.agent.controller.conversation.to_messages(preserve_pending_tail=True),
                ensure_ascii=False,
                default=str,
            ))
        messages = source_messages(read_metadata(self._session_path(session_id)).get("source"))
        if not messages:
            raise RuntimeError("请先打开该旧会话以补全命名来源")
        return messages

    def _session_path(self, session_id: str) -> Path:
        return self.paths.sessions / f"{self._validated_session_id(session_id)}.kohakutr"

    def _active_session(self, session_id: str) -> ActiveSession:
        session = self.active
        if session is None or session.session_id != self._validated_session_id(session_id):
            raise FileNotFoundError(session_id)
        return session

    @staticmethod
    def _pause_agent(session: ActiveSession) -> None:
        pause = getattr(session.creature.agent, "pause", None)
        if callable(pause):
            pause()

    @staticmethod
    def _resume_agent(session: ActiveSession) -> None:
        resume = getattr(session.creature.agent, "resume", None)
        if callable(resume):
            resume()

    @staticmethod
    def _token_usage(session: ActiveSession | None) -> dict[str, Any]:
        if session is None:
            return {}
        store = getattr(session.creature.agent, "session_store", None)
        if store is None or not callable(getattr(store, "token_usage", None)):
            return {}
        try:
            return store.token_usage(str(session.creature.agent.config.name), by_turn=True)
        except Exception:
            return {}

    @staticmethod
    def _validated_session_id(value: str) -> str:
        value = str(value or "").strip()
        if not _SESSION_ID_RE.fullmatch(value):
            raise ValueError("session_id must contain only letters, numbers, dot, underscore, or hyphen")
        return value

    @staticmethod
    def _session_payload(session: ActiveSession) -> dict[str, Any]:
        branch_view = getattr(session, "branch_view", {})
        if not isinstance(branch_view, dict):
            branch_view = {}
        return {
            "session_id": session.session_id,
            "profile_id": session.profile_id,
            "path": str(session.path),
            "resumed": session.resumed,
            "opened_at": session.opened_at,
            "branch_view": dict(branch_view),
        }
