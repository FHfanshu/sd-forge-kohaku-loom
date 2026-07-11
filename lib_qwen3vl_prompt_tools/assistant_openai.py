from __future__ import annotations

import urllib.parse
from typing import Any, Iterator

from openai import OpenAI, OpenAIError

from .assistant_common import (
    _assistant_estimate_tokens,
    _assistant_request_messages,
    _assistant_stream_event,
    _extract_tool_calls,
)
from .constants import ASSISTANT_TOOLS
from .response_text import _clean_response_text, _extract_message_text
from .utils import _payload_bool


def _openai_base_url(endpoint: str) -> str:
    value = endpoint.strip().rstrip("/")
    if value.endswith("/chat/completions"):
        value = value[: -len("/chat/completions")]
    parsed = urllib.parse.urlparse(value)
    if parsed.netloc.lower() == "api.deepseek.com" or value.endswith("/v1"):
        return value
    return value + "/v1"


def _openai_chat_url(endpoint: str) -> str:
    return _openai_base_url(endpoint).rstrip("/") + "/chat/completions"


def _openai_headers(api_key: str) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _openai_client(endpoint: str, api_key: str, timeout: int) -> OpenAI:
    return OpenAI(base_url=_openai_base_url(endpoint), api_key=api_key or "not-needed", timeout=timeout)


def _openai_request_body(payload: dict[str, Any], model: str, *, stream: bool = False) -> dict[str, Any]:
    disable_tools = _payload_bool(payload.get("disable_tools"), False)
    body: dict[str, Any] = {
        "model": model,
        "messages": _assistant_request_messages(payload.get("messages") or [], disable_tools, bool(payload.get("_session_context"))),
        "temperature": float(payload.get("temperature") if payload.get("temperature") is not None else 0.35),
        "top_p": float(payload.get("top_p") if payload.get("top_p") is not None else 0.9),
        "max_tokens": int(payload.get("max_tokens") if payload.get("max_tokens") is not None else 8192),
        "stream": stream,
    }
    if stream:
        body["stream_options"] = {"include_usage": True}
    if not disable_tools:
        body["tools"] = ASSISTANT_TOOLS
        body["tool_choice"] = "auto"
    is_deepseek = payload.get("_legacy_backend") == "deepseek" or urllib.parse.urlparse(str(payload.get("endpoint") or "")).netloc.lower() == "api.deepseek.com"
    if payload.get("reasoning_enabled") is not False and is_deepseek:
        body["reasoning_effort"] = str(payload.get("reasoning_effort") or "low")
        body["extra_body"] = {"thinking": {"type": "enabled"}}
    return body


def _sdk_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if hasattr(value, "model_dump"):
        result = value.model_dump(exclude_none=True)
        return result if isinstance(result, dict) else {}
    return {}


def _openai_usage(data: dict[str, Any], body: dict[str, Any], output_text: str) -> dict[str, int]:
    raw = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    input_tokens = raw.get("prompt_tokens") or raw.get("input_tokens")
    if input_tokens is None:
        input_tokens = _assistant_estimate_tokens(str(body.get("messages") or ""))
    output_tokens = raw.get("completion_tokens") or raw.get("output_tokens")
    if output_tokens is None:
        output_tokens = _assistant_estimate_tokens(output_text)
    completion_details = raw.get("completion_tokens_details") if isinstance(raw.get("completion_tokens_details"), dict) else {}
    prompt_details = raw.get("prompt_tokens_details") if isinstance(raw.get("prompt_tokens_details"), dict) else {}
    thought_tokens = raw.get("reasoning_tokens") or completion_details.get("reasoning_tokens") or 0
    cached_tokens = raw.get("cached_tokens") or prompt_details.get("cached_tokens") or 0
    total_tokens = raw.get("total_tokens") or int(input_tokens or 0) + int(output_tokens or 0) + int(thought_tokens or 0)
    return {
        "input_tokens": int(input_tokens or 0),
        "output_tokens": int(output_tokens or 0),
        "thought_tokens": int(thought_tokens or 0),
        "cached_tokens": int(cached_tokens or 0),
        "total_tokens": int(total_tokens or 0),
    }


def _openai_result(data: dict[str, Any], body: dict[str, Any], model: str, endpoint: str) -> dict[str, Any]:
    choices = data.get("choices") or []
    if not choices or not isinstance(choices[0], dict) or not isinstance(choices[0].get("message"), dict):
        raise RuntimeError("OpenAI response is missing choices[0].message")
    message = choices[0]["message"]
    tool_calls = _extract_tool_calls(message)
    text = _clean_response_text(message.get("content", "")) if tool_calls else _extract_message_text(message)
    reasoning = _openai_delta_reasoning(message)
    return {
        "text": text,
        "reasoning": reasoning,
        "tool_calls": tool_calls,
        "model": model,
        "endpoint": endpoint,
        "usage": _openai_usage(data, body, text),
    }


def _prompt_assistant_chat_openai(payload: dict[str, Any], endpoint: str, model: str, api_key: str) -> dict[str, Any]:
    body = _openai_request_body(payload, model)
    errors: list[str] = []
    for candidate in [endpoint, *(payload.get("fallback_endpoints") or [])]:
        try:
            with _openai_client(candidate, api_key, int(payload.get("timeout") or 120)) as client:
                response = client.chat.completions.create(**body)
            return _openai_result(_sdk_dict(response), body, model, candidate)
        except (OpenAIError, RuntimeError, ValueError) as exc:
            errors.append(f"{candidate}: {exc}")
    raise RuntimeError("OpenAI assistant API failed: " + " | ".join(errors))


def _prompt_assistant_stream_openai(
    payload: dict[str, Any], endpoint: str, model: str, api_key: str
) -> Iterator[str]:
    try:
        body = _openai_request_body(payload, model, stream=True)
    except Exception as exc:  # noqa: BLE001
        yield _assistant_stream_event("error", {"error": str(exc)})
        return
    input_tokens = _assistant_estimate_tokens(str(body.get("messages") or ""))
    yield _assistant_stream_event(
        "usage",
        {"usage": {"input_tokens": input_tokens, "output_tokens": 0, "thought_tokens": 0, "cached_tokens": 0, "total_tokens": input_tokens}},
    )
    errors: list[str] = []
    for candidate in [endpoint, *(payload.get("fallback_endpoints") or [])]:
        emitted_content = False
        attempts = [body]
        for attempt in attempts:
            try:
                text_parts: list[str] = []
                reasoning_parts: list[str] = []
                streamed_tools: dict[int, dict[str, Any]] = {}
                usage_data: dict[str, Any] = {}
                with _openai_client(candidate, api_key, int(payload.get("timeout") or 120)) as client:
                    for chunk in client.chat.completions.create(**attempt):
                        data = _sdk_dict(chunk)
                        if isinstance(data.get("usage"), dict):
                            usage_data = data
                        choices = data.get("choices") or []
                        if not choices or not isinstance(choices[0], dict):
                            if usage_data:
                                yield _assistant_stream_event("usage", {"usage": _openai_usage(usage_data, attempt, "".join(text_parts))})
                            continue
                        delta = choices[0].get("delta")
                        if not isinstance(delta, dict):
                            continue
                        _append_stream_tool_calls(streamed_tools, delta)
                        delta_text = _openai_delta_text(delta)
                        delta_reasoning = _openai_delta_reasoning(delta)
                        if delta_reasoning:
                            reasoning_parts.append(delta_reasoning)
                            yield _assistant_stream_event("reasoning_delta", {"text": delta_reasoning, "usage": _openai_usage(usage_data, attempt, "".join(text_parts))})
                        if delta_text:
                            emitted_content = True
                            text_parts.append(delta_text)
                            yield _assistant_stream_event("delta", {"text": delta_text, "usage": _openai_usage(usage_data, attempt, "".join(text_parts))})
                text = _clean_response_text("".join(text_parts))
                tool_calls = _extract_tool_calls({"tool_calls": [streamed_tools[key] for key in sorted(streamed_tools)]})
                if not text and not tool_calls:
                    raise RuntimeError("OpenAI stream returned empty output")
                yield _assistant_stream_event(
                    "done",
                    {"text": text, "reasoning": "".join(reasoning_parts), "tool_calls": tool_calls, "model": model, "endpoint": candidate, "usage": _openai_usage(usage_data, attempt, text)},
                )
                return
            except (OpenAIError, RuntimeError, ValueError) as exc:
                if not emitted_content and "stream_options" in attempt and _openai_stream_usage_unsupported(exc):
                    retry = dict(attempt)
                    retry.pop("stream_options", None)
                    attempts.append(retry)
                    continue
                errors.append(f"{candidate}: {exc}")
                break
        if emitted_content:
            break
    yield _assistant_stream_event("error", {"error": "OpenAI assistant stream failed: " + " | ".join(errors)})


def _append_stream_tool_calls(accumulated: dict[int, dict[str, Any]], delta: dict[str, Any]) -> None:
    calls = delta.get("tool_calls") or []
    if isinstance(delta.get("function_call"), dict):
        calls = [{"index": 0, "function": delta["function_call"]}, *calls]
    for fallback_index, call in enumerate(calls):
        if not isinstance(call, dict):
            continue
        index = call.get("index") if isinstance(call.get("index"), int) else fallback_index
        target = accumulated.setdefault(index, {"id": "", "function": {"name": "", "arguments": ""}})
        if call.get("id"):
            target["id"] = str(call["id"])
        function = call.get("function") if isinstance(call.get("function"), dict) else {}
        if function.get("name"):
            target["function"]["name"] += str(function["name"])
        if function.get("arguments") is not None:
            target["function"]["arguments"] += str(function["arguments"])


def _openai_stream_usage_unsupported(error: Exception) -> bool:
    message = str(error).lower()
    return ("stream_options" in message or "include_usage" in message) and any(marker in message for marker in ("unsupported", "unknown", "invalid", "400", "extra"))


def _openai_delta_text(delta: dict[str, Any]) -> str:
    content = delta.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            str(part.get("text") or "")
            for part in content
            if isinstance(part, dict) and str(part.get("type") or "") in {"text", "output_text"}
        )
    return ""


def _openai_delta_reasoning(delta: dict[str, Any]) -> str:
    value = delta.get("reasoning_content", delta.get("reasoning", ""))
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(str(part.get("text") or "") for part in value if isinstance(part, dict))
    return ""
