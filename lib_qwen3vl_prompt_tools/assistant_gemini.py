from __future__ import annotations

import base64
import json
import re
import urllib.parse
from typing import Any

import httpx
from google import genai
from google.genai import errors as genai_errors
from google.genai import types as genai_types

from .assistant_common import TOOLS_DISABLED_INSTRUCTION, _assistant_estimate_tokens, _assistant_stream_event
from .assistant_profiles import _assistant_use_gemini_native
from .assistant_teacher import prepare_teacher_messages
from .constants import ASSISTANT_TOOLS, PROMPT_ASSISTANT_SYSTEM
from .image_payloads import _data_url_inline_data
from .response_text import _clean_response_text
from .utils import _payload_bool

_SENSITIVE_PROMPT_RE = re.compile(
    r"\b(?:"
    r"completely\s+nude|colored\s+sclera|male\s+focus|sniffing\s+penis|"
    r"nsfw|uncensored|nude|naked|explicit|sexual|sex|genitalia|genitals|"
    r"penis|cock|dick|erection|erect|precum|cum|semen|sperm|ejaculat\w*|"
    r"nipples?|areola|crotch|groin|anus|anal|ass|butt|pussy|vagina|balls?|testicles?|"
    r"fellatio|oral\s+sex|paizuri|masturbat\w*"
    r")\b|(?:裸体|全裸|阴茎|勃起|精液|射精|乳头|性器|成人|露出|下体)",
    re.IGNORECASE,
)


class _PromptSanitizer:
    def __init__(self, enabled: bool = True) -> None:
        self.enabled = enabled
        self._by_key: dict[str, str] = {}
        self._slots: dict[str, str] = {}

    def sanitize_text(self, text: Any) -> str:
        value = str(text or "")
        if not self.enabled or not value or value.startswith("data:image/"):
            return value

        def replace(match: re.Match[str]) -> str:
            raw = match.group(0)
            key = raw.lower()
            slot = self._by_key.get(key)
            if not slot:
                slot = f"SAFE_SLOT_{len(self._by_key) + 1:03d}"
                self._by_key[key] = slot
                self._slots[slot] = raw
            return slot

        return _SENSITIVE_PROMPT_RE.sub(replace, value)

    def sanitize_obj(self, value: Any) -> Any:
        if isinstance(value, str):
            return self.sanitize_text(value)
        if isinstance(value, list):
            return [self.sanitize_obj(item) for item in value]
        if isinstance(value, dict):
            return {key: self.sanitize_obj(item) for key, item in value.items()}
        return value

    def sanitize_messages(self, messages: list[Any]) -> list[Any]:
        return [self.sanitize_obj(item) for item in messages]

    def restore_text(self, text: Any) -> str:
        value = str(text or "")
        if not value or not self._slots:
            return value
        for slot, raw in sorted(self._slots.items(), key=lambda item: len(item[0]), reverse=True):
            value = value.replace(slot, raw)
        return value

    def restore_obj(self, value: Any) -> Any:
        if isinstance(value, str):
            return self.restore_text(value)
        if isinstance(value, list):
            return [self.restore_obj(item) for item in value]
        if isinstance(value, dict):
            return {key: self.restore_obj(item) for key, item in value.items()}
        return value

    @property
    def slots(self) -> int:
        return len(self._slots)


def _restore_gemini_result(result: dict[str, Any], sanitizer: _PromptSanitizer) -> dict[str, Any]:
    if sanitizer.slots <= 0:
        return result
    restored = dict(result)
    restored["text"] = sanitizer.restore_text(restored.get("text", ""))
    restored["tool_calls"] = sanitizer.restore_obj(restored.get("tool_calls", []))
    restored["sanitized_slots"] = sanitizer.slots
    return restored


def _redact_gemini_result(result: dict[str, Any]) -> dict[str, Any]:
    sanitizer = _PromptSanitizer(True)
    redacted = dict(result)
    redacted["text"] = sanitizer.sanitize_text(redacted.get("text", ""))
    redacted["tool_calls"] = sanitizer.sanitize_obj(redacted.get("tool_calls", []))
    redacted["sanitized_slots"] = sanitizer.slots
    return redacted


def _gemini_headers(api_key: str) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["x-goog-api-key"] = api_key
        if api_key.startswith("sk-"):
            headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _gemini_url(endpoint: str, model: str, stream: bool = False) -> str:
    base = endpoint.strip().rstrip("/")
    action = "streamGenerateContent" if stream else "generateContent"
    model_path = urllib.parse.quote(model.strip(), safe="")
    if "/v1beta/" in base and ":" in base.rsplit("/", 1)[-1]:
        url = base
    elif base.endswith("/v1beta"):
        url = f"{base}/models/{model_path}:{action}"
    else:
        url = f"{base}/v1beta/models/{model_path}:{action}"
    if stream:
        separator = "&" if "?" in url else "?"
        url = f"{url}{separator}alt=sse"
    return url


def _gemini_base_url(endpoint: str) -> str:
    """Normalize legacy Gemini-native endpoints for the SDK base URL."""
    base = endpoint.strip().rstrip("/")
    for version in ("/v1beta", "/v1"):
        marker = version + "/models/"
        if marker in base:
            return base.split(marker, 1)[0]
        if base.endswith(version):
            return base[: -len(version)]
    return base


def _gemini_client(endpoint: str, api_key: str, timeout: int) -> genai.Client:
    headers = {}
    if api_key.startswith("sk-"):
        # NewAPI-style relays commonly require bearer auth in addition to Gemini's API-key header.
        headers["Authorization"] = f"Bearer {api_key}"
    return genai.Client(
        api_key=api_key or "not-needed",
        http_options=genai_types.HttpOptions(
            base_url=_gemini_base_url(endpoint),
            headers=headers or None,
            timeout=max(timeout, 1) * 1000,
        ),
    )


def _gemini_text_parts_from_content(content: Any) -> list[dict[str, Any]]:
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                item_type = str(item.get("type") or "")
                if item_type == "text" and item.get("text"):
                    parts.append({"text": str(item.get("text"))})
                image_url = item.get("image_url") or {}
                url = image_url.get("url") if isinstance(image_url, dict) else ""
                if item_type == "image_url" and url:
                    parts.append(_data_url_inline_data(str(url)))
            elif item:
                parts.append({"text": str(item)})
        return parts
    text = str(content or "").strip()
    return [{"text": text}] if text else []


def _gemini_contents(messages: list[Any], preserve_window: bool = False) -> tuple[list[dict[str, Any]], int]:
    contents = []
    input_tokens = _assistant_estimate_tokens(PROMPT_ASSISTANT_SYSTEM)
    pending_functions: dict[str, str] = {}
    for item in (messages if preserve_window else messages[-20:]):
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip()
        if role not in {"user", "assistant", "tool"}:
            continue
        parts = _gemini_text_parts_from_content(item.get("content", ""))
        if role == "assistant" and isinstance(item.get("tool_calls"), list):
            for index, call in enumerate(item["tool_calls"]):
                if not isinstance(call, dict):
                    continue
                function = call.get("function") if isinstance(call.get("function"), dict) else {}
                name = str(function.get("name") or call.get("tool") or call.get("name") or "").strip()
                if not name:
                    continue
                arguments = function.get("arguments", call.get("arguments", {}))
                if isinstance(arguments, str):
                    try:
                        arguments = json.loads(arguments) if arguments.strip() else {}
                    except json.JSONDecodeError:
                        arguments = {}
                call_id = str(call.get("id") or f"call_{index}")
                parts.append({"functionCall": {"id": call_id, "name": name, "args": arguments if isinstance(arguments, dict) else {}}})
                pending_functions[call_id] = name
        if role == "tool":
            name = pending_functions.pop(str(item.get("tool_call_id") or ""), "")
            if not name:
                continue
            response: Any = item.get("content", "")
            if isinstance(response, str):
                try:
                    response = json.loads(response) if response.strip() else {}
                except json.JSONDecodeError:
                    response = {"result": response}
            if not isinstance(response, dict):
                response = {"result": response}
            parts = [{"functionResponse": {"id": str(item.get("tool_call_id") or ""), "name": name, "response": response}}]
        image = str(item.get("image") or item.get("data_url") or "").strip()
        if image:
            parts.append(_data_url_inline_data(image))
            input_tokens += 1024
        if not parts:
            continue
        for part in parts:
            if "text" in part:
                input_tokens += _assistant_estimate_tokens(part["text"])
        contents.append({"role": "model" if role == "assistant" else "tool" if role == "tool" else "user", "parts": parts})
    return contents, input_tokens


def _gemini_tools() -> list[dict[str, Any]]:
    declarations = []
    for tool in ASSISTANT_TOOLS:
        function = tool.get("function") or {}
        if isinstance(function, dict) and function.get("name"):
            declarations.append(
                {
                    "name": function.get("name"),
                    "description": function.get("description", ""),
                    "parameters": function.get("parameters", {"type": "object", "properties": {}}),
                }
            )
    return [{"functionDeclarations": declarations}] if declarations else []


def _gemini_request_body(payload: dict[str, Any], messages: list[Any]) -> tuple[dict[str, Any], int]:
    contents, input_tokens = _gemini_contents(messages, _payload_bool(payload.get("_session_context"), False))
    if not contents:
        raise RuntimeError("message is empty")
    disable_tools = _payload_bool(payload.get("disable_tools"), False)
    system_prompt = PROMPT_ASSISTANT_SYSTEM + (TOOLS_DISABLED_INSTRUCTION if disable_tools else "")
    if _payload_bool(payload.get("_session_context"), False):
        summaries = [str(item.get("content") or "").strip() for item in messages if isinstance(item, dict) and item.get("role") == "system"]
        if summaries:
            system_prompt += "\n\n" + "\n\n".join(summaries)
    body: dict[str, Any] = {
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "contents": contents,
        "generationConfig": {
            "temperature": float(payload.get("temperature") or 0.35),
            "topP": float(payload.get("top_p") or 0.9),
            "maxOutputTokens": int(payload.get("max_tokens") or 8192),
        },
        "safetySettings": [
            {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"},
        ],
    }
    if payload.get("reasoning_enabled") is not False:
        effort = str(payload.get("reasoning_effort") or "low").strip().lower()
        body["generationConfig"]["thinkingConfig"] = {"thinkingLevel": "LOW" if effort == "low" else "HIGH"}
    if not disable_tools:
        body["tools"] = _gemini_tools()
        body["toolConfig"] = {"functionCallingConfig": {"mode": "AUTO"}}
    return body, input_tokens


def _gemini_sdk_contents(body: dict[str, Any]) -> list[genai_types.Content]:
    contents: list[genai_types.Content] = []
    for content in body.get("contents") or []:
        if not isinstance(content, dict):
            continue
        parts: list[genai_types.Part] = []
        for part in content.get("parts") or []:
            if not isinstance(part, dict):
                continue
            if part.get("text") is not None:
                parts.append(genai_types.Part.from_text(text=str(part["text"])))
                continue
            function_call = part.get("functionCall") or part.get("function_call")
            if isinstance(function_call, dict) and function_call.get("name"):
                function = genai_types.FunctionCall(
                    id=str(function_call.get("id") or "") or None,
                    name=str(function_call["name"]),
                    args=function_call.get("args") if isinstance(function_call.get("args"), dict) else {},
                )
                parts.append(genai_types.Part(function_call=function))
                continue
            function_response = part.get("functionResponse") or part.get("function_response")
            if isinstance(function_response, dict) and function_response.get("name"):
                response = genai_types.FunctionResponse(
                    id=str(function_response.get("id") or "") or None,
                    name=str(function_response["name"]),
                    response=function_response.get("response") if isinstance(function_response.get("response"), dict) else {},
                )
                parts.append(genai_types.Part(function_response=response))
                continue
            inline_data = part.get("inlineData")
            if isinstance(inline_data, dict) and inline_data.get("data"):
                try:
                    data = base64.b64decode(str(inline_data["data"]), validate=True)
                except Exception as exc:  # noqa: BLE001
                    raise RuntimeError("invalid Gemini image data") from exc
                parts.append(
                    genai_types.Part.from_bytes(
                        data=data,
                        mime_type=str(inline_data.get("mimeType") or "image/jpeg"),
                    )
                )
        if parts:
            contents.append(genai_types.Content(role=str(content.get("role") or "user"), parts=parts))
    if not contents:
        raise RuntimeError("message is empty")
    return contents


def _gemini_sdk_config(body: dict[str, Any]) -> genai_types.GenerateContentConfig:
    generation = body.get("generationConfig") if isinstance(body.get("generationConfig"), dict) else {}
    config: dict[str, Any] = {
        "system_instruction": body.get("systemInstruction"),
        "temperature": generation.get("temperature"),
        "top_p": generation.get("topP"),
        "max_output_tokens": generation.get("maxOutputTokens"),
        "safety_settings": body.get("safetySettings"),
    }
    thinking = generation.get("thinkingConfig")
    if isinstance(thinking, dict):
        config["thinking_config"] = {"thinking_level": thinking.get("thinkingLevel")}
    tools = []
    for tool in body.get("tools") or []:
        if not isinstance(tool, dict):
            continue
        declarations = []
        for declaration in tool.get("functionDeclarations") or []:
            if not isinstance(declaration, dict):
                continue
            declarations.append(
                {
                    "name": declaration.get("name"),
                    "description": declaration.get("description"),
                    "parameters_json_schema": declaration.get("parameters"),
                }
            )
        if declarations:
            tools.append({"function_declarations": declarations})
    if tools:
        config["tools"] = tools
        config["automatic_function_calling"] = {"disable": True}
    tool_config = body.get("toolConfig")
    if isinstance(tool_config, dict):
        function_config = tool_config.get("functionCallingConfig")
        if isinstance(function_config, dict):
            config["tool_config"] = {"function_calling_config": {"mode": function_config.get("mode")}}
    return genai_types.GenerateContentConfig(**{key: value for key, value in config.items() if value is not None})


def _gemini_sdk_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if hasattr(value, "model_dump"):
        try:
            result = value.model_dump(by_alias=True, exclude_none=True)
        except TypeError:
            result = value.model_dump()
        return result if isinstance(result, dict) else {}
    return {}


def _gemini_low_reasoning_body(body: dict[str, Any]) -> dict[str, Any]:
    retry = dict(body)
    retry["generationConfig"] = dict(body.get("generationConfig") or {})
    if "thinkingConfig" in retry["generationConfig"]:
        retry["generationConfig"]["thinkingConfig"] = {"thinkingLevel": "LOW"}
    return retry


def _gemini_usage(data: dict[str, Any], input_tokens: int = 0, output_text: str = "") -> dict[str, int]:
    raw = data.get("usageMetadata") or data.get("usage") or {}
    prompt = raw.get("promptTokenCount") or raw.get("input_tokens") or raw.get("prompt_tokens") or input_tokens
    output = raw.get("candidatesTokenCount") or raw.get("output_tokens") or raw.get("completion_tokens") or _assistant_estimate_tokens(output_text)
    thoughts = raw.get("thoughtsTokenCount") or raw.get("reasoning_tokens") or 0
    cached = raw.get("cachedContentTokenCount") or raw.get("cached_content_token_count") or raw.get("cached_tokens") or 0
    total = raw.get("totalTokenCount") or raw.get("total_tokens") or int(prompt or 0) + int(output or 0) + int(thoughts or 0)
    return {
        "input_tokens": int(prompt or 0),
        "output_tokens": int(output or 0),
        "thought_tokens": int(thoughts or 0),
        "cached_tokens": int(cached or 0),
        "total_tokens": int(total or 0),
    }


def _gemini_response_parts(data: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    candidates = data.get("candidates") or []
    if not candidates:
        return "", []
    content = (candidates[0].get("content") or {}) if isinstance(candidates[0], dict) else {}
    parts = content.get("parts") or []
    text_parts = []
    tool_calls = []
    for part in parts:
        if not isinstance(part, dict):
            continue
        if part.get("text") and not part.get("thought"):
            text_parts.append(str(part.get("text")))
        function_call = part.get("functionCall") or part.get("function_call")
        if isinstance(function_call, dict):
            name = str(function_call.get("name") or "").strip()
            args = function_call.get("args") or function_call.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args) if args.strip() else {}
                except json.JSONDecodeError:
                    args = {}
            if name:
                normalized = {"tool": name, "arguments": args if isinstance(args, dict) else {}}
                if function_call.get("id"):
                    normalized["id"] = str(function_call["id"])
                tool_calls.append(normalized)
    return _clean_response_text("\n".join(text_parts)), tool_calls


def _gemini_reasoning_text(data: dict[str, Any]) -> str:
    candidates = data.get("candidates") or []
    if not candidates or not isinstance(candidates[0], dict):
        return ""
    content = candidates[0].get("content") or {}
    parts = content.get("parts") or [] if isinstance(content, dict) else []
    return "".join(str(part.get("text") or "") for part in parts if isinstance(part, dict) and part.get("thought"))


def _gemini_empty_response_detail(data: dict[str, Any]) -> str:
    candidates = data.get("candidates") or []
    prompt_feedback = data.get("promptFeedback") or {}
    details = []
    if not candidates:
        details.append("no candidates")
    else:
        candidate = candidates[0] if isinstance(candidates[0], dict) else {}
        finish = str(candidate.get("finishReason") or "").strip()
        if finish:
            details.append(f"finishReason={finish}")
        finish_message = str(candidate.get("finishMessage") or "").strip()
        if finish_message:
            details.append(f"finishMessage={finish_message}")
        content = candidate.get("content") or {}
        parts = content.get("parts") or [] if isinstance(content, dict) else []
        if parts:
            part_keys = sorted({key for part in parts if isinstance(part, dict) for key in part.keys()})
            details.append("partKeys=" + ",".join(part_keys))
    block_reason = str(prompt_feedback.get("blockReason") or "").strip()
    if block_reason:
        details.append(f"promptBlockReason={block_reason}")
    safety = []
    for item in (candidates[0].get("safetyRatings") if candidates and isinstance(candidates[0], dict) else None) or prompt_feedback.get("safetyRatings") or []:
        if not isinstance(item, dict):
            continue
        if item.get("blocked") or item.get("probability") in {"MEDIUM", "HIGH"}:
            safety.append(f"{item.get('category')}:{item.get('probability')}")
    if safety:
        details.append("safety=" + ",".join(safety))
    usage = data.get("usageMetadata") or {}
    if usage:
        details.append("usage=" + json.dumps(usage, ensure_ascii=False))
    return "; ".join(details) or "no visible text or function call"


def _gemini_result_from_data(data: dict[str, Any], input_tokens: int, model: str, endpoint: str) -> dict[str, Any]:
    text, tool_calls = _gemini_response_parts(data)
    reasoning = _gemini_reasoning_text(data)
    usage = _gemini_usage(data, input_tokens=input_tokens, output_text=text)
    if not text and not tool_calls:
        raise RuntimeError("Gemini returned empty visible output: " + _gemini_empty_response_detail(data))
    return {"text": text, "reasoning": reasoning, "tool_calls": tool_calls, "model": model, "endpoint": endpoint, "usage": usage}


def _gemini_post_generate(endpoint: str, model: str, api_key: str, body: dict[str, Any], timeout: int, input_tokens: int, sanitizer: _PromptSanitizer | None = None) -> dict[str, Any]:
    with _gemini_client(endpoint, api_key, timeout) as client:
        response = client.models.generate_content(
            model=model,
            contents=_gemini_sdk_contents(body),
            config=_gemini_sdk_config(body),
        )
    result = _gemini_result_from_data(_gemini_sdk_dict(response), input_tokens, model, endpoint)
    return _restore_gemini_result(result, sanitizer) if sanitizer else result


def _prompt_assistant_chat_gemini(payload: dict[str, Any], endpoint: str, model: str, api_key: str) -> dict[str, Any]:
    messages = payload.get("messages") or []
    if not isinstance(messages, list):
        raise RuntimeError("messages must be a list")
    sanitizer = _PromptSanitizer(_payload_bool(payload.get("sanitize_sensitive"), True))
    sanitized_messages = sanitizer.sanitize_messages(messages)
    teacher_messages, teacher_info = _gemini_teacher_messages(payload, sanitized_messages)
    body, input_tokens = _gemini_request_body(payload, teacher_messages)
    errors = []
    for candidate_endpoint in [endpoint, *(payload.get("fallback_endpoints") or [])]:
        try:
            result = _gemini_post_generate(candidate_endpoint, model, api_key, body, int(payload.get("timeout") or 120), input_tokens, sanitizer)
            result.update(teacher_info)
            return _redact_gemini_result(result) if _payload_bool(payload.get("redact_output"), False) else result
        except (genai_errors.APIError, httpx.HTTPError, RuntimeError, ValueError, OSError) as exc:
            if "empty visible output" in str(exc) and str(payload.get("reasoning_effort") or "low").lower() != "low":
                try:
                    result = _gemini_post_generate(candidate_endpoint, model, api_key, _gemini_low_reasoning_body(body), int(payload.get("timeout") or 120), input_tokens, sanitizer)
                    result.update(teacher_info, reasoning_retry="low")
                    return _redact_gemini_result(result) if _payload_bool(payload.get("redact_output"), False) else result
                except (genai_errors.APIError, httpx.HTTPError, RuntimeError, ValueError, OSError) as retry_exc:
                    errors.append(f"{candidate_endpoint} high reasoning empty, low retry failed: {retry_exc}")
            errors.append(f"{candidate_endpoint}: {exc}")
    raise RuntimeError("Gemini assistant API failed: " + " | ".join(errors))


def _prompt_assistant_stream_gemini(payload: dict[str, Any], endpoint: str, model: str, api_key: str):
    messages = payload.get("messages") or []
    if not isinstance(messages, list):
        yield _assistant_stream_event("error", {"error": "messages must be a list"})
        return
    try:
        sanitizer = _PromptSanitizer(_payload_bool(payload.get("sanitize_sensitive"), True))
        teacher_messages, teacher_info = _gemini_teacher_messages(payload, sanitizer.sanitize_messages(messages))
        body, input_tokens = _gemini_request_body(payload, teacher_messages)
    except Exception as exc:  # noqa: BLE001
        yield _assistant_stream_event("error", {"error": str(exc)})
        return
    yield _assistant_stream_event("usage", {"usage": {"input_tokens": input_tokens, "output_tokens": 0, "thought_tokens": 0, "cached_tokens": 0, "total_tokens": input_tokens}})
    errors = []
    for candidate_endpoint in [endpoint, *(payload.get("fallback_endpoints") or [])]:
        emitted_content = False
        try:
            with _gemini_client(candidate_endpoint, api_key, int(payload.get("timeout") or 120)) as client:
                text_parts: list[str] = []
                reasoning_parts: list[str] = []
                tool_calls: list[dict[str, Any]] = []
                usage = {"input_tokens": input_tokens, "output_tokens": 0, "thought_tokens": 0, "cached_tokens": 0, "total_tokens": input_tokens}
                for response in client.models.generate_content_stream(
                    model=model,
                    contents=_gemini_sdk_contents(body),
                    config=_gemini_sdk_config(body),
                ):
                    data = _gemini_sdk_dict(response)
                    delta_text, delta_tools = _gemini_response_parts(data)
                    delta_reasoning = _gemini_reasoning_text(data)
                    if delta_reasoning:
                        reasoning_parts.append(delta_reasoning)
                        usage = _gemini_usage(data, input_tokens=input_tokens, output_text="".join(text_parts))
                        yield _assistant_stream_event("reasoning_delta", {"text": delta_reasoning, "usage": usage})
                    if delta_tools:
                        tool_calls.extend(delta_tools)
                    if delta_text:
                        emitted_content = True
                        text_parts.append(delta_text)
                        usage = _gemini_usage(data, input_tokens=input_tokens, output_text="".join(text_parts))
                        yield _assistant_stream_event("delta", {"text": delta_text, "usage": usage})
                    elif data.get("usageMetadata"):
                        usage = _gemini_usage(data, input_tokens=input_tokens, output_text="".join(text_parts))
                        yield _assistant_stream_event("usage", {"usage": usage})
                text = _clean_response_text("".join(text_parts))
                if not text and not tool_calls:
                    try:
                        retry = _gemini_post_generate(candidate_endpoint, model, api_key, _gemini_low_reasoning_body(body), int(payload.get("timeout") or 120), input_tokens, sanitizer)
                        retry["stream_retry"] = True
                        retry.update(teacher_info)
                        yield _assistant_stream_event("done", _redact_gemini_result(retry) if _payload_bool(payload.get("redact_output"), False) else retry)
                        return
                    except Exception as exc:  # noqa: BLE001
                        errors.append(f"{candidate_endpoint} stream empty, non-stream retry failed: {exc}")
                        continue
                result = {"text": text, "reasoning": "".join(reasoning_parts), "tool_calls": tool_calls, "model": model, "endpoint": candidate_endpoint, "usage": usage, **teacher_info}
                restored = _restore_gemini_result(result, sanitizer)
                yield _assistant_stream_event("done", _redact_gemini_result(restored) if _payload_bool(payload.get("redact_output"), False) else restored)
                return
        except (genai_errors.APIError, httpx.HTTPError, RuntimeError, ValueError, OSError) as exc:
            errors.append(f"{candidate_endpoint}: {exc}")
            if emitted_content:
                break
    yield _assistant_stream_event("error", {"error": "Gemini assistant stream failed: " + " | ".join(errors)})


def _gemini_teacher_messages(payload: dict[str, Any], messages: list[Any]) -> tuple[list[Any], dict[str, Any]]:
    # A local briefing is text-only, so it cannot carry an in-progress native function exchange.
    if any(isinstance(item, dict) and (item.get("role") == "tool" or item.get("tool_calls")) for item in messages):
        return messages, {"teacher_mode": "structure-preserving-redaction"}
    return prepare_teacher_messages(payload, messages)
