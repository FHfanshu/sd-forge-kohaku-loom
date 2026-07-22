"""Bounded, protocol-aware profile connectivity checks."""

from __future__ import annotations

import asyncio
import time
import urllib.parse
from typing import Any

import httpx

from prompt_agent.provider_errors import safe_provider_error

from .profile_contracts import GEMINI_NATIVE, OPENAI_CHAT_COMPLETIONS, normalize_profile


CONNECTION_TIMEOUT_SECONDS = 8.0


class ConnectionTestError(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool = False, status_code: int = 502):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.status_code = status_code


async def test_profile_connection(profile: dict[str, Any]) -> dict[str, Any]:
    api_key = profile.get("api_key", profile.get("apiKey", ""))
    if api_key is None:
        api_key = ""
    if not isinstance(api_key, str) or len(api_key) > 16_384:
        raise ConnectionTestError("invalid_profile", "The model profile configuration is invalid.", status_code=422)
    try:
        normalized = normalize_profile(profile)
    except ValueError as error:
        raise ConnectionTestError("invalid_profile", "The model profile configuration is invalid.", status_code=422) from error
    if not normalized.get("enabled", True):
        raise ConnectionTestError("profile_disabled", "The selected model profile is disabled.", status_code=409)
    if normalized["protocol"] not in {OPENAI_CHAT_COMPLETIONS, GEMINI_NATIVE}:
        raise ConnectionTestError("unsupported_protocol", "The selected model protocol is not supported.", status_code=422)

    endpoints = [endpoint for endpoint in (normalized["endpoint"], *normalized["fallback_endpoints"]) if endpoint]
    if not endpoints:
        raise ConnectionTestError("invalid_profile", "The model profile has no endpoint configured.", status_code=422)
    errors: list[BaseException] = []
    timeout = _timeout(normalized)
    request_timeout = httpx.Timeout(timeout, connect=min(3.0, timeout))
    deadline = time.monotonic() + timeout
    headers = {"Accept": "application/json"}
    if normalized["protocol"] == OPENAI_CHAT_COMPLETIONS and api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    async with httpx.AsyncClient(timeout=request_timeout, trust_env=True) as client:
        for index, endpoint in enumerate(endpoints):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                errors.append(TimeoutError())
                break
            try:
                async with asyncio.timeout(remaining):
                    if normalized["protocol"] == GEMINI_NATIVE:
                        url, params = _gemini_model_request(endpoint, normalized["model_id"], api_key)
                        response = await client.get(url, headers=headers, params=params)
                        response.raise_for_status()
                        transport = "gemini-native model metadata"
                    else:
                        url = _openai_models_url(endpoint)
                        response = await client.get(url, headers=headers)
                        response.raise_for_status()
                        transport = "openai-compatible model catalog"
                return {
                    "ok": True,
                    "profile_id": normalized["profile_id"],
                    "model": normalized["model_id"],
                    "protocol": normalized["protocol"],
                    "runtime": normalized["runtime"],
                    "transport": transport,
                    "endpoint_index": index,
                }
            except Exception as error:  # cancellation is a BaseException and must propagate
                errors.append(error)

    last_error = errors[-1] if errors else RuntimeError("no endpoint configured")
    message = safe_provider_error(last_error)
    retryable = _retryable(last_error)
    raise ConnectionTestError("connection_failed", message, retryable=retryable) from last_error


def _timeout(profile: dict[str, Any]) -> float:
    parameters = profile.get("parameters")
    configured = parameters.get("timeout", CONNECTION_TIMEOUT_SECONDS) if isinstance(parameters, dict) else CONNECTION_TIMEOUT_SECONDS
    try:
        value = float(configured)
    except (TypeError, ValueError):
        value = CONNECTION_TIMEOUT_SECONDS
    return min(CONNECTION_TIMEOUT_SECONDS, max(1.0, value))


def _openai_models_url(endpoint: str) -> str:
    value = endpoint.strip().rstrip("/")
    if value.endswith("/models"):
        return value
    if value.endswith("/chat/completions"):
        value = value[: -len("/chat/completions")].rstrip("/")
    parsed = urllib.parse.urlparse(value)
    path = parsed.path.rstrip("/")
    if path.lower().endswith(("/v1", "/v1beta", "/openai")):
        path += "/models"
    else:
        path += "/v1/models"
    return urllib.parse.urlunparse(parsed._replace(path=path))


def _gemini_model_request(endpoint: str, model: str, api_key: str) -> tuple[str, dict[str, str]]:
    value = endpoint.strip().rstrip("/")
    parsed = urllib.parse.urlparse(value)
    path = parsed.path.rstrip("/")
    marker = "/models/"
    if marker in path:
        path = path.split(marker, 1)[0] + marker + urllib.parse.quote(model, safe="")
    else:
        version = path if path.endswith(("/v1", "/v1beta")) else "/v1beta"
        if version.endswith("/v1"):
            version = version[: -len("/v1")] + "/v1beta"
        path = version.rstrip("/") + "/models/" + urllib.parse.quote(model, safe="")
    url = urllib.parse.urlunparse(parsed._replace(path=path, query="", fragment=""))
    return url, {"key": api_key} if api_key else {}


def _retryable(error: BaseException) -> bool:
    name = type(error).__name__.lower()
    return "timeout" in name or "connect" in name or "network" in name or getattr(error, "status_code", 0) in {408, 425, 429, 500, 502, 503, 504}
