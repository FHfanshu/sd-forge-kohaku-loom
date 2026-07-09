from __future__ import annotations

import json
import re
import urllib.parse
from typing import Any

import requests

from .assistant_common import _assistant_estimate_tokens, _assistant_stream_event
from .assistant_teacher import prepare_teacher_messages
from .constants import ASSISTANT_TOOLS, DEFAULT_ASSISTANT_FALLBACK_ENDPOINT, PROMPT_ASSISTANT_SYSTEM
from .image_payloads import _data_url_inline_data
from .response_text import _clean_response_text, _response_json_utf8, _response_text_utf8
from .utils import _payload_bool

def _assistant_use_gemini_native(backend: str, endpoint: str, model: str) -> bool:
    if backend == "local-lmcpp":
        return False
    lowered_model = model.lower()
    if lowered_model.startswith("gemini-") or "gemini" in lowered_model:
        return True
    try:
        host = urllib.parse.urlparse(endpoint).netloc.lower()
    except Exception:
        host = ""
    return backend == "moyuu" or host in {"moyuu.cc", "hk-api.moyuu.cc"}


def _assistant_remote_endpoints(endpoint: str, payload: dict[str, Any]) -> list[str]:
    candidates = [endpoint.strip().rstrip("/")]
    raw_fallback = str(payload.get("fallback_endpoint") or DEFAULT_ASSISTANT_FALLBACK_ENDPOINT).strip()
    for item in re.split(r"[,\s]+", raw_fallback):
        item = item.strip().rstrip("/")
        if item:
            candidates.append(item)
    result = []
    seen = set()
    for item in candidates:
        if item and item not in seen:
            seen.add(item)
            result.append(item)
    return result


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


def _gemini_contents(messages: list[Any]) -> tuple[list[dict[str, Any]], int]:
    contents = []
    input_tokens = _assistant_estimate_tokens(PROMPT_ASSISTANT_SYSTEM)
    for item in messages[-20:]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip()
        if role not in {"user", "assistant"}:
            continue
        parts = _gemini_text_parts_from_content(item.get("content", ""))
        image = str(item.get("image") or item.get("data_url") or "").strip()
        if image:
            parts.append(_data_url_inline_data(image))
            input_tokens += 1024
        if not parts:
            continue
        for part in parts:
            if "text" in part:
                input_tokens += _assistant_estimate_tokens(part["text"])
        contents.append({"role": "model" if role == "assistant" else "user", "parts": parts})
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
    contents, input_tokens = _gemini_contents(messages)
    if not contents:
        raise RuntimeError("message is empty")
    body: dict[str, Any] = {
        "systemInstruction": {"parts": [{"text": PROMPT_ASSISTANT_SYSTEM}]},
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
    if not _payload_bool(payload.get("disable_tools"), False):
        body["tools"] = _gemini_tools()
        body["toolConfig"] = {"functionCallingConfig": {"mode": "AUTO"}}
    return body, input_tokens


def _gemini_usage(data: dict[str, Any], input_tokens: int = 0, output_text: str = "") -> dict[str, int]:
    raw = data.get("usageMetadata") or data.get("usage") or {}
    prompt = raw.get("promptTokenCount") or raw.get("input_tokens") or raw.get("prompt_tokens") or input_tokens
    output = raw.get("candidatesTokenCount") or raw.get("output_tokens") or raw.get("completion_tokens") or _assistant_estimate_tokens(output_text)
    thoughts = raw.get("thoughtsTokenCount") or raw.get("reasoning_tokens") or 0
    total = raw.get("totalTokenCount") or raw.get("total_tokens") or int(prompt or 0) + int(output or 0) + int(thoughts or 0)
    return {
        "input_tokens": int(prompt or 0),
        "output_tokens": int(output or 0),
        "thought_tokens": int(thoughts or 0),
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
        if part.get("text"):
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
                tool_calls.append({"tool": name, "arguments": args if isinstance(args, dict) else {}})
    return _clean_response_text("\n".join(text_parts)), tool_calls


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
    usage = _gemini_usage(data, input_tokens=input_tokens, output_text=text)
    if not text and not tool_calls:
        raise RuntimeError("Gemini returned empty visible output: " + _gemini_empty_response_detail(data))
    return {"text": text, "tool_calls": tool_calls, "model": model, "endpoint": endpoint, "usage": usage}


def _gemini_post_generate(endpoint: str, model: str, api_key: str, body: dict[str, Any], timeout: int, input_tokens: int, sanitizer: _PromptSanitizer | None = None) -> dict[str, Any]:
    response = requests.post(_gemini_url(endpoint, model), json=body, headers=_gemini_headers(api_key), timeout=timeout)
    if response.status_code >= 400:
        detail = _response_text_utf8(response).strip()
        raise RuntimeError(f"{response.status_code} {detail or response.reason}")
    result = _gemini_result_from_data(_response_json_utf8(response), input_tokens, model, endpoint)
    return _restore_gemini_result(result, sanitizer) if sanitizer else result


def _prompt_assistant_chat_gemini(payload: dict[str, Any], endpoint: str, model: str, api_key: str) -> dict[str, Any]:
    messages = payload.get("messages") or []
    if not isinstance(messages, list):
        raise RuntimeError("messages must be a list")
    sanitizer = _PromptSanitizer(_payload_bool(payload.get("sanitize_sensitive"), True))
    teacher_messages, teacher_info = prepare_teacher_messages(payload, sanitizer.sanitize_messages(messages))
    body, input_tokens = _gemini_request_body(payload, teacher_messages)
    errors = []
    for candidate_endpoint in _assistant_remote_endpoints(endpoint, payload):
        try:
            result = _gemini_post_generate(candidate_endpoint, model, api_key, body, int(payload.get("timeout") or 120), input_tokens, sanitizer)
            result.update(teacher_info)
            return result
        except (requests.RequestException, RuntimeError, json.JSONDecodeError) as exc:
            errors.append(f"{candidate_endpoint}: {exc}")
            if str(exc).startswith(("401 ", "403 ")):
                break
    raise RuntimeError("Gemini assistant API failed: " + " | ".join(errors))


def _prompt_assistant_stream_gemini(payload: dict[str, Any], endpoint: str, model: str, api_key: str):
    messages = payload.get("messages") or []
    if not isinstance(messages, list):
        yield _assistant_stream_event("error", {"error": "messages must be a list"})
        return
    try:
        sanitizer = _PromptSanitizer(_payload_bool(payload.get("sanitize_sensitive"), True))
        teacher_messages, teacher_info = prepare_teacher_messages(payload, sanitizer.sanitize_messages(messages))
        body, input_tokens = _gemini_request_body(payload, teacher_messages)
    except Exception as exc:  # noqa: BLE001
        yield _assistant_stream_event("error", {"error": str(exc)})
        return
    yield _assistant_stream_event("usage", {"usage": {"input_tokens": input_tokens, "output_tokens": 0, "thought_tokens": 0, "total_tokens": input_tokens}})
    errors = []
    for candidate_endpoint in _assistant_remote_endpoints(endpoint, payload):
        url = _gemini_url(candidate_endpoint, model, stream=True)
        try:
            with requests.post(url, json=body, headers=_gemini_headers(api_key), timeout=int(payload.get("timeout") or 120), stream=True) as response:
                if response.status_code >= 400:
                    detail = _response_text_utf8(response).strip()
                    errors.append(f"{candidate_endpoint}: {response.status_code} {detail or response.reason}")
                    if response.status_code in {401, 403}:
                        break
                    continue
                text_parts: list[str] = []
                tool_calls: list[dict[str, Any]] = []
                usage = {"input_tokens": input_tokens, "output_tokens": 0, "thought_tokens": 0, "total_tokens": input_tokens}
                for raw_line in response.iter_lines(decode_unicode=False):
                    if isinstance(raw_line, bytes):
                        line = raw_line.decode("utf-8", errors="replace").strip()
                    else:
                        line = str(raw_line or "").strip()
                    if not line:
                        continue
                    if line.startswith("data:"):
                        line = line[5:].strip()
                    if not line or line == "[DONE]":
                        continue
                    try:
                        data = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    delta_text, delta_tools = _gemini_response_parts(data)
                    if delta_tools:
                        tool_calls.extend(delta_tools)
                    if delta_text:
                        text_parts.append(delta_text)
                        output_text = "".join(text_parts)
                        usage = _gemini_usage(data, input_tokens=input_tokens, output_text=output_text)
                        yield _assistant_stream_event("delta", {"text": delta_text, "usage": usage})
                    elif data.get("usageMetadata"):
                        usage = _gemini_usage(data, input_tokens=input_tokens, output_text="".join(text_parts))
                        yield _assistant_stream_event("usage", {"usage": usage})
                text = _clean_response_text("".join(text_parts))
                usage = usage or _gemini_usage({}, input_tokens=input_tokens, output_text=text)
                if not text and not tool_calls:
                    try:
                        retry = _gemini_post_generate(candidate_endpoint, model, api_key, body, int(payload.get("timeout") or 120), input_tokens, sanitizer)
                        retry["stream_retry"] = True
                        retry.update(teacher_info)
                        yield _assistant_stream_event("done", retry)
                        return
                    except Exception as exc:  # noqa: BLE001
                        errors.append(f"{candidate_endpoint} stream empty, non-stream retry failed: {exc}")
                        continue
                result = {"text": text, "tool_calls": tool_calls, "model": model, "endpoint": candidate_endpoint, "usage": usage, **teacher_info}
                yield _assistant_stream_event("done", _restore_gemini_result(result, sanitizer))
                return
        except (requests.RequestException, RuntimeError, json.JSONDecodeError) as exc:
            errors.append(f"{candidate_endpoint}: {exc}")
    yield _assistant_stream_event("error", {"error": "Gemini assistant stream failed: " + " | ".join(errors)})
