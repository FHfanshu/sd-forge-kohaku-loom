from __future__ import annotations

import asyncio
import json
import logging
import time
import urllib.parse
from collections.abc import AsyncIterator
from typing import Any

import httpx

from ..contracts import StreamRequest
from ..errors import ProviderProxyError
from .common import (
    AdapterCapabilities,
    event,
    image_data,
    iter_sse,
    json_payload,
    normalize_usage,
    parameter,
    sanitized_error_code,
    text_content,
    timeout_seconds,
    tool_definitions,
    usage,
)


_LOGGER = logging.getLogger("prompt_agent.provider_proxy")
GEMINI_CAPABILITIES = AdapterCapabilities()


async def stream_gemini(request: StreamRequest, profile: dict[str, Any]) -> AsyncIterator[str]:
    endpoint = _generate_url(str(profile["endpoint"]), str(profile["model_id"]))
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    if profile.get("api_key"):
        headers["x-goog-api-key"] = str(profile["api_key"])
    body: dict[str, Any] = {
        "contents": _contents(request.messages),
        "generationConfig": {
            "temperature": request.temperature if request.temperature is not None else float(parameter(profile, "temperature", 0.35)),
            "topP": request.top_p if request.top_p is not None else float(parameter(profile, "top_p", 0.9)),
            "maxOutputTokens": request.max_tokens if request.max_tokens is not None else int(parameter(profile, "max_tokens", 8192)),
        },
    }
    if request.system_prompt:
        body["systemInstruction"] = {"parts": [{"text": request.system_prompt}]}
    if request.tools:
        body["tools"] = [{
            "functionDeclarations": [
                {"name": tool["name"], "description": tool["description"], "parameters": tool["parameters"]}
                for tool in tool_definitions(request.tools)
            ],
        }]
    if request.reasoning not in {"off", "none"} and _reasoning_enabled(profile):
        maximum = int(body["generationConfig"]["maxOutputTokens"])
        body["generationConfig"]["thinkingConfig"] = {
            "includeThoughts": True,
            "thinkingBudget": min(maximum, _reasoning_budget(request.reasoning, maximum)),
        }

    usage_value = usage()
    thinking_started = False
    text_started = False
    function_calls: list[dict[str, Any]] = []
    finish_reason = "stop"
    saw_payload = False
    saw_finish = False
    status_code: int | None = None
    error_code = "none"
    started_at = time.monotonic()
    try:
        yield event("start")
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout_seconds(profile)), trust_env=True) as client:
            async with client.stream("POST", endpoint, headers=headers, json=body) as response:
                status_code = response.status_code
                response.raise_for_status()
                async for _, raw in iter_sse(response):
                    if raw.strip() == "[DONE]":
                        saw_finish = True
                        continue
                    try:
                        payload = json_payload(raw)
                    except ValueError as error:
                        raise ProviderProxyError("provider_malformed_response", status_code=status_code) from error
                    if payload.get("error") is not None:
                        raise ProviderProxyError("provider_malformed_response", status_code=status_code)
                    saw_payload = True
                    if isinstance(payload.get("usageMetadata"), dict):
                        usage_value = normalize_usage(payload["usageMetadata"])
                    candidates = payload.get("candidates") or []
                    if not candidates or not isinstance(candidates[0], dict):
                        continue
                    candidate = candidates[0]
                    finish_reason = _finish_reason(candidate.get("finishReason"), finish_reason)
                    saw_finish = saw_finish or bool(candidate.get("finishReason"))
                    content = candidate.get("content") if isinstance(candidate.get("content"), dict) else {}
                    parts = content.get("parts") if isinstance(content.get("parts"), list) else []
                    for part in parts:
                        if not isinstance(part, dict):
                            continue
                        text = str(part.get("text") or "")
                        if text:
                            if part.get("thought") is True:
                                if not thinking_started:
                                    thinking_started = True
                                    yield event("thinking_start", contentIndex=0)
                                yield event("thinking_delta", contentIndex=0, delta=text)
                            else:
                                index = 1 if thinking_started else 0
                                if not text_started:
                                    text_started = True
                                    yield event("text_start", contentIndex=index)
                                yield event("text_delta", contentIndex=index, delta=text)
                        call = part.get("functionCall")
                        if isinstance(call, dict):
                            _merge_function_call(function_calls, call)
        if not saw_payload or (not saw_finish and not function_calls):
            raise ProviderProxyError("provider_unexpected_eof", status_code=status_code)
        if thinking_started:
            yield event("thinking_end", contentIndex=0)
        if text_started:
            yield event("text_end", contentIndex=1 if thinking_started else 0)
        offset = int(thinking_started) + int(text_started)
        for position, call in enumerate(function_calls, start=offset):
            yield event("toolcall_start", contentIndex=position, id=str(call.get("id") or f"call_{position}"), toolName=str(call.get("name") or "unknown"))
            yield event("toolcall_delta", contentIndex=position, delta=json.dumps(call.get("args") or {}, ensure_ascii=True, separators=(",", ":")))
            yield event("toolcall_end", contentIndex=position)
        yield event("done", reason="toolUse" if function_calls else finish_reason, usage=usage_value)
    except asyncio.CancelledError:
        error_code = "request_cancelled"
        raise
    except GeneratorExit:
        error_code = "request_cancelled"
        raise
    except Exception as error:  # noqa: BLE001
        error_code = sanitized_error_code(error)
        raise
    finally:
        _LOGGER.info(
            "provider_proxy request_id=%s provider_id=gemini status=%s duration_ms=%d error_code=%s",
            request.request_id,
            status_code or 0,
            max(0, int((time.monotonic() - started_at) * 1000)),
            error_code,
        )


def _generate_url(endpoint: str, model: str) -> str:
    value = endpoint.strip().rstrip("/")
    if value.endswith(":generateContent"):
        value = value[: -len(":generateContent")] + ":streamGenerateContent"
    elif not value.endswith(":streamGenerateContent"):
        parsed = urllib.parse.urlparse(value)
        path = parsed.path.rstrip("/")
        if "/models/" in path:
            path = path.split("/models/", 1)[0] + "/models/" + urllib.parse.quote(model, safe="")
        else:
            version = path if path.endswith(("/v1", "/v1beta")) else "/v1beta"
            path = version.rstrip("/") + "/models/" + urllib.parse.quote(model, safe="")
        value = urllib.parse.urlunparse(parsed._replace(path=path + ":streamGenerateContent", query="", fragment=""))
    parsed = urllib.parse.urlparse(value)
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    query["alt"] = ["sse"]
    return urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(query, doseq=True), fragment=""))


def _contents(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role == "toolResult":
            result.append({
                "role": "user",
                "parts": [{"functionResponse": {
                    "name": str(message.get("toolName") or "tool"),
                    "response": {"content": text_content(message.get("content"))},
                }}],
            })
            continue
        if role not in {"user", "assistant", "model"}:
            continue
        parts = _parts(message.get("content"))
        if parts:
            result.append({"role": "model" if role == "assistant" else role, "parts": parts})
    if not result or not any(item["role"] == "user" for item in result):
        raise ValueError("messages must include user content")
    return result


def _parts(content: Any) -> list[dict[str, Any]]:
    blocks = content if isinstance(content, list) else [{"type": "text", "text": str(content or "")}]
    result: list[dict[str, Any]] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type == "text":
            result.append({"text": str(block.get("text") or "")})
        elif block_type == "thinking":
            result.append({"text": str(block.get("thinking") or ""), "thought": True})
        elif block_type == "image":
            image = image_data(block)
            if image:
                mime_type, data = image
                result.append({"inlineData": {"mimeType": mime_type, "data": data}})
        elif block_type == "toolCall":
            result.append({"functionCall": {
                "name": str(block.get("name") or "unknown"),
                "args": block.get("arguments") if isinstance(block.get("arguments"), dict) else {},
            }})
    return result


def _merge_function_call(target: list[dict[str, Any]], call: dict[str, Any]) -> None:
    name = str(call.get("name") or "unknown")
    args = call.get("args") if isinstance(call.get("args"), dict) else {}
    for current in target:
        if current.get("name") == name:
            current["args"].update(args)
            return
    target.append({"id": str(call.get("id") or ""), "name": name, "args": dict(args)})


def _finish_reason(value: Any, current: str) -> str:
    if value == "MAX_TOKENS":
        return "length"
    if value in {"STOP", "FINISH_REASON_UNSPECIFIED", "SAFETY", "RECITATION"}:
        return "stop"
    if value == "MALFORMED_FUNCTION_CALL":
        return "toolUse"
    return current


def _reasoning_budget(level: str, maximum: int) -> int:
    ratios = {"minimal": 0.15, "low": 0.25, "medium": 0.4, "high": 0.6, "xhigh": 0.8, "max": 0.9}
    return max(1024, int(maximum * ratios.get(level, 0.25)))


def _reasoning_enabled(profile: dict[str, Any]) -> bool:
    capabilities = profile.get("capabilities")
    return not isinstance(capabilities, dict) or capabilities.get("reasoning", True)
