from __future__ import annotations

import json
from typing import Any

from .constants import PROMPT_ASSISTANT_SYSTEM
from .response_text import _clean_response_text

TOOLS_DISABLED_INSTRUCTION = "\n\nTools are disabled for this convergence turn. Do not emit tool calls or tool-call JSON. Answer the user's original request directly using the tool results already in the conversation."


def _assistant_message_content(item: dict[str, Any]) -> str | list[dict[str, Any]]:
    raw_content = item.get("content", "")
    parts: list[dict[str, Any]] = []
    if isinstance(raw_content, list):
        for part in raw_content:
            if not isinstance(part, dict):
                if part:
                    parts.append({"type": "text", "text": str(part)})
                continue
            part_type = str(part.get("type") or "")
            if part_type == "text" and part.get("text"):
                parts.append({"type": "text", "text": str(part["text"])})
            elif part_type == "image_url" and part.get("image_url"):
                parts.append({"type": "image_url", "image_url": part["image_url"]})
    else:
        text = str(raw_content or "").strip()
        if text:
            parts.append({"type": "text", "text": text})
    image = str(item.get("image") or item.get("data_url") or "").strip()
    if image:
        parts.append({"type": "image_url", "image_url": {"url": image}})
    if not image and not isinstance(raw_content, list):
        return str(raw_content or "").strip()
    return parts


def _assistant_request_messages(messages: list[Any], disable_tools: bool = False, preserve_window: bool = False) -> list[dict[str, Any]]:
    system_prompt = PROMPT_ASSISTANT_SYSTEM + (TOOLS_DISABLED_INSTRUCTION if disable_tools else "")
    request_messages = [{"role": "system", "content": system_prompt}]
    pending_tool_call_ids: set[str] = set()
    for item in (messages if preserve_window else messages[-20:]):
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip()
        if role == "assistant" and isinstance(item.get("tool_calls"), list):
            tool_calls = []
            for index, call in enumerate(item["tool_calls"]):
                if not isinstance(call, dict):
                    continue
                function = call.get("function") if isinstance(call.get("function"), dict) else {}
                name = str(function.get("name") or call.get("tool") or call.get("name") or "").strip()
                if not name:
                    continue
                arguments = function.get("arguments", call.get("arguments", {}))
                if not isinstance(arguments, str):
                    arguments = json.dumps(arguments if isinstance(arguments, dict) else {}, ensure_ascii=False)
                tool_calls.append({
                    "id": str(call.get("id") or f"call_{index}"),
                    "type": "function",
                    "function": {"name": name, "arguments": arguments},
                })
            if tool_calls:
                request_messages.append({"role": "assistant", "content": item.get("content") or None, "tool_calls": tool_calls})
                pending_tool_call_ids.update(call["id"] for call in tool_calls)
                continue
        if role == "tool":
            tool_call_id = str(item.get("tool_call_id") or "").strip()
            if tool_call_id in pending_tool_call_ids:
                request_messages.append({"role": "tool", "tool_call_id": tool_call_id, "content": str(item.get("content") or "")})
                pending_tool_call_ids.discard(tool_call_id)
            continue
        content = _assistant_message_content(item)
        if role in {"system", "user", "assistant"} and content:
            request_messages.append({"role": role, "content": content})
    if len(request_messages) == 1:
        raise RuntimeError("message is empty")
    return request_messages
def _assistant_estimate_tokens(text: str) -> int:
    value = str(text or "")
    if not value:
        return 0
    return max(1, (len(value) + 3) // 4)


def _assistant_stream_event(event_type: str, data: dict[str, Any]) -> str:
    return json.dumps({"type": event_type, **data}, ensure_ascii=False) + "\n"
def _extract_tool_calls(message: dict[str, Any]) -> list[dict[str, Any]]:
    result = []

    def append_call(call: Any) -> None:
        if not isinstance(call, dict):
            return
        function = call.get("function")
        function = function if isinstance(function, dict) else {}
        name = str(function.get("name") or call.get("name") or "").strip()
        if isinstance(function, dict) and function.get("arguments") is not None:
            raw_args = function.get("arguments")
        else:
            raw_args = call.get("arguments", call.get("input", call.get("args")))
        if not name:
            return
        arguments: Any = raw_args or {}
        if isinstance(raw_args, str):
            try:
                arguments = json.loads(raw_args) if raw_args.strip() else {}
            except json.JSONDecodeError:
                arguments = {"diff": raw_args}
        if not isinstance(arguments, dict):
            arguments = {}
        normalized = {"tool": name, "arguments": arguments}
        if call.get("id"):
            normalized["id"] = str(call["id"])
        result.append(normalized)

    calls = message.get("tool_calls") or []
    if isinstance(calls, str):
        try:
            calls = json.loads(calls) if calls.strip() else []
        except json.JSONDecodeError:
            calls = []
    if isinstance(calls, dict):
        calls = [calls]
    for call in calls:
        append_call(call)

    append_call(message.get("function_call"))

    content = message.get("content")
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and str(part.get("type") or "") in {"tool_use", "tool_call", "function_call"}:
                append_call(part)
    return result
