from __future__ import annotations

import asyncio
import hmac
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from fastapi import Body, FastAPI, Header, HTTPException, Query
from fastapi.responses import StreamingResponse

from kohaku_loom.forge_bridge import ForgeToolBroker, encode_sse
from kohaku_loom.profile_store import LoomProfileStore
from kohaku_loom.provider_errors import safe_provider_error
from kohaku_loom.runtime_paths import LoomRuntimePaths
from kohaku_loom.sidecar.runtime import LoomSidecarRuntime
from kohaku_loom.utils import http_transport_summary


_PROFILE_TEST_TIMEOUT_SECONDS = 60.0


def _profile_connection_error(error: BaseException) -> str:
    return safe_provider_error(error)


@dataclass
class SidecarActivity:
    last_activity: float

    def touch(self) -> None:
        self.last_activity = time.monotonic()


def create_app(
    token: str,
    paths: LoomRuntimePaths | None = None,
    broker: ForgeToolBroker | None = None,
    runtime: LoomSidecarRuntime | None = None,
) -> tuple[FastAPI, SidecarActivity]:
    runtime_paths = (paths or LoomRuntimePaths.under()).ensure()
    profiles = LoomProfileStore(runtime_paths)
    activity = SidecarActivity(time.monotonic())
    tool_broker = broker or ForgeToolBroker()
    loom_runtime = runtime or LoomSidecarRuntime(
        runtime_paths,
        profiles,
        tool_broker,
        on_activity=activity.touch,
    )
    @asynccontextmanager
    async def lifespan(_: FastAPI):
        try:
            yield
        finally:
            await loom_runtime.close()

    app = FastAPI(
        title="Kohaku Loom Sidecar",
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.loom_runtime = loom_runtime

    def authorize(authorization: str) -> None:
        scheme, _, supplied = str(authorization or "").partition(" ")
        if scheme.lower() != "bearer" or not hmac.compare_digest(supplied, token):
            raise HTTPException(status_code=401, detail="invalid sidecar token")
        activity.touch()

    @app.get("/health")
    async def health(authorization: str = Header(default="")) -> dict[str, Any]:
        authorize(authorization)
        try:
            import kohakuterrarium

            kt_version = str(getattr(kohakuterrarium, "__version__", "unknown"))
        except Exception as error:
            raise HTTPException(status_code=503, detail=f"KohakuTerrarium unavailable: {error}") from error
        return {
            "ok": True,
            "service": "kohaku-loom",
            "kohakuterrarium_version": kt_version,
            "runtime_root": str(runtime_paths.root),
        }

    @app.get("/profiles")
    async def list_profiles(authorization: str = Header(default="")) -> dict[str, Any]:
        authorize(authorization)
        return profiles.list_state()

    @app.post("/profiles/import")
    async def import_profiles(
        payload: dict[str, Any] = Body(...),
        authorization: str = Header(default=""),
    ) -> dict[str, Any]:
        authorize(authorization)
        try:
            return profiles.import_state(payload)
        except (RuntimeError, TypeError, ValueError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.post("/profiles/{profile_id}/chat")
    async def profile_chat(
        profile_id: str,
        payload: dict[str, Any] = Body(...),
        authorization: str = Header(default=""),
    ) -> dict[str, Any]:
        authorize(authorization)
        try:
            requested_timeout = float(payload.get("timeout", _PROFILE_TEST_TIMEOUT_SECONDS))
        except (TypeError, ValueError) as error:
            raise HTTPException(status_code=400, detail="timeout must be a number") from error
        if requested_timeout <= 0:
            raise HTTPException(status_code=400, detail="timeout must be positive")
        timeout = min(requested_timeout, _PROFILE_TEST_TIMEOUT_SECONDS)
        try:
            profile = profiles.resolve(profile_id)
            transport = http_transport_summary(str(profile.get("endpoint") or ""))
        except KeyError:
            transport = "direct"
        try:
            result = await asyncio.wait_for(
                loom_runtime.profile_chat(profile_id, payload.get("messages")),
                timeout=timeout,
            )
            return {**result, "transport": transport, "timeout": timeout}
        except TimeoutError as error:
            raise HTTPException(
                status_code=504,
                detail=f"Model connection test timed out after {timeout:g} seconds. Route: {transport}.",
            ) from error
        except KeyError as error:
            raise HTTPException(status_code=404, detail=f"unknown profile: {error.args[0]}") from error
        except Exception as error:
            raise HTTPException(
                status_code=502,
                detail=f"{_profile_connection_error(error)} Route: {transport}.",
            ) from error

    @app.get("/tools/events")
    async def tool_events(
        after: int = Query(default=0, ge=0),
        last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
        authorization: str = Header(default=""),
    ) -> StreamingResponse:
        authorize(authorization)
        try:
            cursor = max(after, int(last_event_id or 0))
        except ValueError as error:
            raise HTTPException(status_code=400, detail="Last-Event-ID must be an integer") from error

        async def stream():
            async for event in tool_broker.subscribe(cursor):
                if event is not None:
                    activity.touch()
                yield encode_sse(event)

        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.post("/tools/replies/{request_id}")
    async def tool_reply(
        request_id: str,
        payload: dict[str, Any] = Body(...),
        authorization: str = Header(default=""),
    ) -> dict[str, Any]:
        authorize(authorization)
        bridge_id = str(payload.pop("bridge_id", "") or "")
        status = await tool_broker.reply(request_id, payload, bridge_id)
        if status == "unknown":
            raise HTTPException(status_code=404, detail="unknown tool request")
        if status == "superseded":
            raise HTTPException(status_code=409, detail="tool request already completed")
        if status == "foreign":
            raise HTTPException(status_code=409, detail="tool request belongs to another Forge tab")
        return {"ok": True, "status": status}

    @app.post("/tools/bridge")
    async def tool_bridge(
        payload: dict[str, Any] = Body(...),
        authorization: str = Header(default=""),
    ) -> dict[str, Any]:
        authorize(authorization)
        bridge_id = str(payload.get("bridge_id") or "")
        if payload.get("release"):
            return {"ok": True, "released": await tool_broker.release_bridge(bridge_id)}
        try:
            return {"ok": True, **await tool_broker.claim_bridge(bridge_id)}
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.get("/runtime")
    async def runtime_status(authorization: str = Header(default="")) -> dict[str, Any]:
        authorize(authorization)
        return loom_runtime.status()

    @app.get("/sessions")
    async def list_sessions(authorization: str = Header(default="")) -> dict[str, Any]:
        authorize(authorization)
        return {"sessions": loom_runtime.list_sessions()}

    @app.get("/sessions/{session_id}")
    async def session_conversation(
        session_id: str,
        authorization: str = Header(default=""),
    ) -> dict[str, Any]:
        authorize(authorization)
        try:
            return loom_runtime.session_conversation(session_id)
        except (FileNotFoundError, ValueError) as error:
            raise HTTPException(status_code=404, detail="session is not active") from error

    @app.get("/sessions/{session_id}/branches")
    async def session_branches(
        session_id: str,
        authorization: str = Header(default=""),
    ) -> dict[str, Any]:
        authorize(authorization)
        try:
            return loom_runtime.branch_metadata(session_id)
        except (FileNotFoundError, ValueError) as error:
            raise HTTPException(status_code=404, detail="session is not active") from error
        except RuntimeError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.get("/sessions/{session_id}/branch-view")
    async def get_branch_view(
        session_id: str,
        authorization: str = Header(default=""),
    ) -> dict[str, Any]:
        authorize(authorization)
        try:
            return loom_runtime.branch_metadata(session_id)
        except (FileNotFoundError, ValueError) as error:
            raise HTTPException(status_code=404, detail="session is not active") from error
        except RuntimeError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.patch("/sessions/{session_id}/branch-view")
    async def select_branch_view(
        session_id: str,
        payload: dict[str, Any] = Body(...),
        authorization: str = Header(default=""),
    ) -> dict[str, Any]:
        authorize(authorization)
        try:
            return await loom_runtime.select_branch_view(session_id, payload.get("branch_view"))
        except (FileNotFoundError, KeyError) as error:
            raise HTTPException(status_code=404, detail="session is not active") from error
        except (RuntimeError, TypeError, ValueError) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.post("/sessions/{session_id}/branch-view/replay")
    async def replay_branch_view(
        session_id: str,
        payload: dict[str, Any] = Body(default={}),
        authorization: str = Header(default=""),
    ) -> dict[str, Any]:
        authorize(authorization)
        try:
            return await loom_runtime.replay_branch_view(session_id, payload.get("branch_view"))
        except (FileNotFoundError, KeyError) as error:
            raise HTTPException(status_code=404, detail="session is not active") from error
        except (RuntimeError, TypeError, ValueError) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.post("/sessions/{session_id}/regenerate")
    async def regenerate_last_response(
        session_id: str,
        payload: dict[str, Any] = Body(default={}),
        authorization: str = Header(default=""),
    ) -> dict[str, Any]:
        authorize(authorization)
        try:
            return await loom_runtime.regenerate_last_response(session_id, str(payload.get("operation_id") or ""))
        except (FileNotFoundError, KeyError) as error:
            raise HTTPException(status_code=404, detail="session is not active") from error
        except (RuntimeError, TypeError, ValueError) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.post("/sessions/{session_id}/edit-rerun")
    async def edit_and_rerun_message(
        session_id: str,
        payload: dict[str, Any] = Body(...),
        authorization: str = Header(default=""),
    ) -> dict[str, Any]:
        authorize(authorization)
        try:
            return await loom_runtime.edit_and_rerun_message(
                session_id,
                payload.get("content", ""),
                payload.get("turn_index"),
                payload.get("user_position"),
                str(payload.get("operation_id") or ""),
            )
        except (FileNotFoundError, KeyError) as error:
            raise HTTPException(status_code=404, detail="session is not active") from error
        except (RuntimeError, TypeError, ValueError) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.post("/sessions/{session_id}/metadata")
    async def refresh_session_metadata(
        session_id: str,
        payload: dict[str, Any] = Body(default={}),
        authorization: str = Header(default=""),
    ) -> dict[str, Any]:
        authorize(authorization)
        try:
            metadata = loom_runtime.session_metadata(session_id, refresh=bool(payload.get("refresh", False)))
            return {"ok": True, "metadata": metadata}
        except (FileNotFoundError, ValueError) as error:
            raise HTTPException(status_code=404, detail="session not found") from error
        except RuntimeError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.post("/sessions/{session_id}/messages")
    async def enqueue_message(
        session_id: str,
        payload: dict[str, Any] = Body(...),
        authorization: str = Header(default=""),
    ) -> dict[str, Any]:
        authorize(authorization)
        try:
            message = await loom_runtime.enqueue_message(
                session_id,
                payload.get("content"),
                display_content=str(payload.get("display_content") or ""),
                attachments=payload.get("attachments") if isinstance(payload.get("attachments"), list) else [],
                operation_id=str(payload.get("operation_id") or ""),
            )
            return {"ok": True, "message": message}
        except (FileNotFoundError, KeyError) as error:
            raise HTTPException(status_code=404, detail="session not found") from error
        except (RuntimeError, TypeError, ValueError) as error:
            raise HTTPException(status_code=409 if "claimed" in str(error) else 400, detail=str(error)) from error

    @app.patch("/sessions/{session_id}/messages/{message_id}")
    async def edit_message(
        session_id: str,
        message_id: str,
        payload: dict[str, Any] = Body(...),
        authorization: str = Header(default=""),
    ) -> dict[str, Any]:
        authorize(authorization)
        try:
            message = await loom_runtime.edit_message(
                session_id,
                message_id,
                payload.get("content"),
                display_content=str(payload.get("display_content") or ""),
                attachments=payload.get("attachments") if isinstance(payload.get("attachments"), list) else None,
            )
            return {"ok": True, "message": message}
        except (FileNotFoundError, KeyError) as error:
            raise HTTPException(status_code=404, detail="message not found") from error
        except (RuntimeError, TypeError, ValueError) as error:
            raise HTTPException(status_code=409 if "claimed" in str(error) else 400, detail=str(error)) from error

    @app.post("/sessions/{session_id}/messages/{message_id}/cancel")
    async def cancel_message(
        session_id: str,
        message_id: str,
        authorization: str = Header(default=""),
    ) -> dict[str, Any]:
        authorize(authorization)
        try:
            message = await loom_runtime.cancel_message(session_id, message_id)
            return {"ok": True, "message": message}
        except (FileNotFoundError, KeyError) as error:
            raise HTTPException(status_code=404, detail="message not found") from error
        except RuntimeError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.post("/sessions/{session_id}/messages/{message_id}/retry")
    async def retry_message(
        session_id: str,
        message_id: str,
        authorization: str = Header(default=""),
    ) -> dict[str, Any]:
        authorize(authorization)
        try:
            message = await loom_runtime.retry_message(session_id, message_id)
            return {"ok": True, "message": message}
        except (FileNotFoundError, KeyError) as error:
            raise HTTPException(status_code=404, detail="message not found") from error
        except RuntimeError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.post("/sessions/open")
    async def open_session(
        payload: dict[str, Any] = Body(...),
        authorization: str = Header(default=""),
    ) -> dict[str, Any]:
        authorize(authorization)
        try:
            session = await loom_runtime.open_session(
                str(payload.get("profile_id") or ""),
                session_id=str(payload.get("session_id") or ""),
                resume=bool(payload.get("resume", False)),
                forge_bridge=bool(payload.get("forge_bridge", True)),
                agent_mode=str(payload.get("agent_mode") or "normal"),
            )
            return {"ok": True, "session": session}
        except KeyError as error:
            raise HTTPException(status_code=404, detail=f"unknown profile: {error.args[0]}") from error
        except FileNotFoundError as error:
            raise HTTPException(status_code=404, detail=f"session not found: {error}") from error
        except FileExistsError as error:
            raise HTTPException(status_code=409, detail=f"session already exists: {error}") from error
        except (RuntimeError, TypeError, ValueError) as error:
            raise HTTPException(status_code=409 if "already active" in str(error) else 400, detail=str(error)) from error

    @app.post("/sessions/close")
    async def close_session(authorization: str = Header(default="")) -> dict[str, Any]:
        authorize(authorization)
        await loom_runtime.close_session()
        return {"ok": True}

    @app.post("/turns")
    async def start_turn(
        payload: dict[str, Any] = Body(...),
        authorization: str = Header(default=""),
    ) -> dict[str, Any]:
        authorize(authorization)
        timeout_value = payload.get("timeout")
        try:
            timeout = float(timeout_value) if timeout_value is not None else None
            if timeout is not None and timeout <= 0:
                raise ValueError("timeout must be greater than zero")
            return await loom_runtime.start_turn(
                payload.get("content"),
                timeout,
                str(payload.get("operation_id") or ""),
            )
        except (RuntimeError, TypeError, ValueError) as error:
            raise HTTPException(status_code=409 if "already active" in str(error) else 400, detail=str(error)) from error

    @app.get("/turns/events")
    async def turn_events(
        after: int = Query(default=0, ge=0),
        last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
        authorization: str = Header(default=""),
    ) -> StreamingResponse:
        authorize(authorization)
        try:
            cursor = max(after, int(last_event_id or 0))
        except ValueError as error:
            raise HTTPException(status_code=400, detail="Last-Event-ID must be an integer") from error

        async def stream():
            async for event in loom_runtime.events.subscribe(cursor):
                if event is not None:
                    activity.touch()
                yield encode_sse(event)

        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.post("/turns/{turn_id}/cancel")
    async def cancel_turn(
        turn_id: str,
        authorization: str = Header(default=""),
    ) -> dict[str, Any]:
        authorize(authorization)
        status = await loom_runtime.cancel_turn(turn_id)
        if status == "unknown":
            raise HTTPException(status_code=404, detail="unknown active turn")
        return {"ok": True, "status": status}

    return app, activity
