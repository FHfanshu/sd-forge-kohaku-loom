from __future__ import annotations

from typing import Any

from .contracts import parse_stream_request
from .errors import PromptAgentError
from .forge_tools import (
    ForgeTeacherError,
    ForgeToolValidationError,
    TeacherRequest,
    ask_teacher_once,
    execute_catalog_tool,
    public_teacher_error,
    validate_forge_tool_request,
)
from .models import public_models
from .profile_connection import ConnectionTestError, test_profile_connection
from .profiles import ProfileAuthority
from .providers import provider_catalog, public_profile_state, stream_profile


API_PREFIX = "/prompt-agent/api"
API_VERSION = 1
_REGISTRATION_MARKER = "_prompt_agent_api_registered"


def health_payload() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "SD Forge Neo Prompt Agent",
        "api_version": API_VERSION,
        "runtime": "frontend-pi",
        "session_storage": "indexeddb",
        "features": {
            "agent_loop": True,
            "provider_proxy": True,
            "forge_tools": True,
            "profiles": True,
            "local_models": False,
        },
    }


def register_prompt_agent_api(app: Any, profile_authority: ProfileAuthority | None = None) -> None:
    from fastapi import Body, HTTPException
    from fastapi.responses import StreamingResponse

    state = getattr(app, "state", app)
    if getattr(state, _REGISTRATION_MARKER, False):
        return
    setattr(state, _REGISTRATION_MARKER, True)
    profiles = profile_authority or ProfileAuthority()

    @app.get(f"{API_PREFIX}/health")
    async def prompt_agent_health() -> dict[str, Any]:
        return health_payload()

    @app.get(f"{API_PREFIX}/profiles")
    async def prompt_agent_profiles() -> dict[str, Any]:
        return profiles.list_state()

    @app.get(f"{API_PREFIX}/profiles/{{profile_id}}")
    async def prompt_agent_profile(profile_id: str) -> dict[str, Any]:
        try:
            return profiles.get(profile_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="profile not found") from error

    @app.post(f"{API_PREFIX}/profiles")
    async def prompt_agent_create_profile(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        try:
            return profiles.create(payload)
        except (OSError, RuntimeError, ValueError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.patch(f"{API_PREFIX}/profiles/{{profile_id}}")
    async def prompt_agent_update_profile(profile_id: str, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        try:
            return profiles.update(profile_id, payload)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="profile not found") from error
        except (OSError, RuntimeError, ValueError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.delete(f"{API_PREFIX}/profiles/{{profile_id}}", status_code=204)
    async def prompt_agent_delete_profile(profile_id: str) -> None:
        try:
            profiles.delete(profile_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="profile not found") from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.post(f"{API_PREFIX}/profiles/{{profile_id}}/duplicate")
    async def prompt_agent_duplicate_profile(profile_id: str) -> dict[str, Any]:
        try:
            return profiles.duplicate(profile_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="profile not found") from error

    @app.post(f"{API_PREFIX}/profiles/import")
    async def prompt_agent_import_profiles(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        try:
            return profiles.import_legacy_state(payload)
        except (RuntimeError, ValueError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post(f"{API_PREFIX}/profile-routes/default")
    async def prompt_agent_set_profile_route(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        try:
            return profiles.set_default(str(payload.get("role") or ""), str(payload.get("profile_id") or ""))
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post(f"{API_PREFIX}/profiles/restore-defaults")
    async def prompt_agent_restore_default_profiles() -> dict[str, Any]:
        return profiles.restore_defaults()

    @app.get(f"{API_PREFIX}/providers")
    async def prompt_agent_providers() -> dict[str, Any]:
        profile_state = profiles.list_state()
        return {"providers": provider_catalog(profile_state)}

    @app.get(f"{API_PREFIX}/models")
    async def prompt_agent_models() -> dict[str, Any]:
        return public_models(profiles.list_state())

    @app.get(f"{API_PREFIX}/profiles/{{profile_id}}/models")
    async def prompt_agent_profile_models(profile_id: str) -> dict[str, Any]:
        try:
            profile = profiles.get(profile_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="profile not found") from error
        return public_models({"profiles": [profile]})

    @app.post(f"{API_PREFIX}/forge-tools")
    async def prompt_agent_forge_tool(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        try:
            tool = str(payload.get("tool") or "").strip()
            arguments = validate_forge_tool_request(tool, payload.get("arguments", {}))
            if tool in {"list_models", "list_loras", "list_embeddings"}:
                return execute_catalog_tool(tool, arguments)
            if tool != "ask_teacher":
                raise ForgeToolValidationError("This Forge tool must execute in the browser Forge host.")
            state = profiles.list_state()
            teacher_id = str(state.get("teacher_profile_id") or state.get("teacherProfileId") or "")
            if not teacher_id:
                raise ForgeToolValidationError("No teacher profile is selected.")
            teacher_profile = profiles.resolve(teacher_id)
            return await ask_teacher_once(TeacherRequest(**arguments), teacher_profile)
        except KeyError as error:
            raise HTTPException(status_code=404, detail={"ok": False, "error": {"code": "teacher_profile_missing", "message": "The selected teacher profile is unavailable.", "retryable": False}}) from error
        except ForgeToolValidationError as error:
            raise HTTPException(status_code=422, detail={"ok": False, "error": {"code": "validation_error", "message": str(error), "retryable": False}}) from error
        except ForgeTeacherError as error:
            raise HTTPException(status_code=502, detail={"ok": False, "error": {"code": "teacher_failed", "message": public_teacher_error(error), "retryable": True}}) from error

    @app.post(f"{API_PREFIX}/forge-tools/validate")
    async def prompt_agent_validate_forge_tool(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        try:
            tool = str(payload.get("tool") or "").strip()
            arguments = validate_forge_tool_request(tool, payload.get("arguments", {}))
            return {"ok": True, "tool": tool, "arguments": arguments}
        except ForgeToolValidationError as error:
            raise HTTPException(
                status_code=422,
                detail={
                    "ok": False,
                    "error": {
                        "code": "validation_error",
                        "message": str(error),
                        "retryable": False,
                    },
                },
            ) from error

    @app.post(f"{API_PREFIX}/profiles/{{profile_id}}/connection-test")
    async def prompt_agent_profile_connection_test(profile_id: str) -> dict[str, Any]:
        try:
            profile = profiles.resolve(profile_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="profile not found") from error
        except (OSError, RuntimeError, ValueError) as error:
            raise HTTPException(
                status_code=502,
                detail={
                    "ok": False,
                    "error": {
                        "code": "secret_unavailable",
                        "message": "The stored provider credentials are unavailable.",
                        "retryable": False,
                    },
                    "profile_id": profile_id,
                },
            ) from error
        try:
            return await test_profile_connection(profile)
        except ConnectionTestError as error:
            raise HTTPException(
                status_code=error.status_code,
                detail={
                    "ok": False,
                    "error": {
                        "code": error.code,
                        "message": error.message,
                        "retryable": error.retryable,
                    },
                    "profile_id": profile_id,
                },
            ) from error
        except Exception as error:  # noqa: BLE001
            raise HTTPException(
                status_code=502,
                detail={
                    "ok": False,
                    "error": {
                        "code": "connection_failed",
                        "message": "The provider connection test failed.",
                        "retryable": True,
                    },
                    "profile_id": profile_id,
                },
            ) from error

    @app.post(f"{API_PREFIX}/stream")
    async def prompt_agent_stream(payload: dict[str, Any] = Body(...)):
        try:
            request = parse_stream_request(payload)
            profile = profiles.resolve(request.profile_id)
        except KeyError as error:
            detail = PromptAgentError(
                "unknown_profile",
                "The selected model profile is unavailable.",
                request_id=str(payload.get("request_id") or ""),
            )
            raise HTTPException(status_code=404, detail=detail.payload()["error"]) from error
        except (RuntimeError, ValueError) as error:
            detail = PromptAgentError(
                "validation_error",
                str(error),
                request_id=str(payload.get("request_id") or ""),
            )
            raise HTTPException(status_code=422, detail=detail.payload()["error"]) from error
        return StreamingResponse(
            stream_profile(request, profile),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                "X-Request-ID": request.request_id,
            },
        )
