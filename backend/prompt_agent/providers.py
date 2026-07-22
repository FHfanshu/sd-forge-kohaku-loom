from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from typing import Any

# Keep this import in the proxy module so existing test harnesses can replace
# httpx.AsyncClient at the shared module boundary for every adapter.
import httpx

from .contracts import StreamRequest
from .errors import sanitize_provider_error
from .profile_contracts import normalize_profile
from .provider_adapters.common import requested_capability, usage
from .provider_adapters.registry import UnsupportedProviderError, adapter_for_profile, capability_report as profile_capability_report, provider_id_for


_LOGGER = logging.getLogger("prompt_agent.provider_proxy")


def public_profile_state(state: dict[str, Any]) -> dict[str, Any]:
    result = json.loads(json.dumps(state))
    for profile in result.get("profiles", []):
        resolved_provider_id = provider_id_for(profile)
        try:
            provider_capabilities = profile_capability_report(profile)
        except UnsupportedProviderError:
            provider_capabilities = {"supported": {}, "effective": {}, "unsupported": ["provider"]}
        model_path = profile.get("model_path")
        mmproj_path = profile.get("mmproj_path")
        draft_model_path = profile.get("draft_model_path")
        llama_server_path = profile.get("llama_server_path")
        for field in ("api_key", "endpoint", "fallback_endpoints", "model_path", "mmproj_path", "draft_model_path", "llama_server_path"):
            profile.pop(field, None)
        profile["provider_id"] = resolved_provider_id
        profile["model_configured"] = bool(profile.get("model") or profile.get("model_id"))
        profile["local_model_configured"] = bool(model_path)
        profile["mmproj_configured"] = bool(mmproj_path)
        profile["draft_model_configured"] = bool(draft_model_path)
        profile["llama_server_configured"] = bool(llama_server_path)
        profile["provider_capabilities"] = provider_capabilities
    return result


def provider_catalog(state: dict[str, Any]) -> list[dict[str, Any]]:
    providers: dict[str, dict[str, Any]] = {}
    for profile in state.get("profiles", []):
        provider_id = provider_id_for(profile)
        try:
            report = profile_capability_report(profile)
        except UnsupportedProviderError:
            report = {"supported": {}, "effective": {}, "unsupported": ["provider"]}
        entry = providers.setdefault(
            provider_id,
            {
                "id": provider_id,
                "name": _provider_name(provider_id),
                "configured": False,
                "protocol": profile.get("protocol"),
                "runtime": profile.get("runtime"),
                "capabilities": report["effective"],
                "supported_capabilities": report["supported"],
                "unsupported_capabilities": report["unsupported"],
            },
        )
        entry["configured"] = bool(
            entry["configured"]
            or profile.get("has_api_key", profile.get("hasApiKey"))
            or profile.get("runtime") != "remote-http"
        )
    return list(providers.values())


async def stream_profile(request: StreamRequest, profile: dict[str, Any]) -> AsyncIterator[str]:
    normalized = normalize_profile(profile)
    api_key = profile.get("api_key", profile.get("apiKey", ""))
    if isinstance(api_key, str) and len(api_key) <= 16_384:
        normalized["api_key"] = api_key
    if not normalized.get("enabled", True):
        yield _event("start")
        yield _event("error", reason="error", errorCode="profile_disabled", errorMessage="The selected profile is disabled.", usage=_usage())
        return
    try:
        adapter = adapter_for_profile(normalized)
        provider_id = adapter.id
        report = profile_capability_report(normalized)
    except UnsupportedProviderError:
        yield _event("start")
        yield _event(
            "error",
            reason="error",
            errorCode="unsupported_provider",
            errorMessage="The selected provider adapter is not supported.",
            usage=_usage(),
        )
        return
    unsupported = requested_capability(request, normalized, report["effective"])
    if unsupported:
        yield _event("start")
        yield _event(
            "error",
            reason="error",
            errorCode="unsupported_capability",
            capability=unsupported,
            errorMessage=f"The selected provider does not support {unsupported} for this profile.",
            usage=_usage(),
        )
        return
    try:
        async for frame in adapter.stream(request, normalized):
            yield frame
    except asyncio.CancelledError:
        raise
    except GeneratorExit:
        raise
    except Exception as error:  # noqa: BLE001
        sanitized = sanitize_provider_error(error)
        yield _event(
            "error",
            reason="error",
            errorCode=sanitized.code,
            errorMessage=sanitized.message,
            statusCode=sanitized.status_code,
            usage=_usage(),
        )
        _LOGGER.debug("provider proxy terminal error code=%s", sanitized.code)


def _provider_name(provider_id: str) -> str:
    return {
        "openai-compatible": "OpenAI Compatible",
        "gemini": "Gemini",
        "llama-cpp": "llama.cpp",
    }.get(provider_id, provider_id.replace("-", " ").title())


def _usage(*args: int) -> dict[str, Any]:
    return usage(*args)


def _event(event_type: str, **payload: Any) -> str:
    return f"data: {json.dumps({'type': event_type, **payload}, ensure_ascii=True)}\n\n"
