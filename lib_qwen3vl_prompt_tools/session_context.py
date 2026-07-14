from __future__ import annotations

import hashlib
import json
from typing import Any


MAX_TOOL_CONTENT_CHARS = 8000
MAX_SUMMARY_CHARS = 24000


def json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def truncate_text(value: Any, limit: int) -> str:
    text = str(value or "").strip()
    return text if len(text) <= limit else text[: max(0, limit - 3)] + "..."


def compact_tool_result(payload: dict[str, Any], limit: int = MAX_TOOL_CONTENT_CHARS) -> str:
    content = str(payload.get("content") or "")
    result = payload.get("result") if isinstance(payload.get("result"), dict) else None
    if not content and result is not None:
        content = json_text(result)
    if len(content) <= limit:
        return content

    source = result or _decode_object(content)
    compact: dict[str, Any] = {
        "ok": source.get("ok") if isinstance(source, dict) else None,
        "truncated": True,
        "original_chars": len(content),
        "sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
    }
    if isinstance(source, dict):
        for key in (
            "error", "target", "field", "kind", "query", "canonical_query", "name", "id", "total",
            "cursor", "next_cursor", "prompt_hash", "positive_prompt_hash", "negative_prompt_hash", "context_hash",
            "prompt_preview", "positive_prompt", "negative_prompt", "style_template", "forge_preset", "checkpoint",
        ):
            if source.get(key) not in (None, "", [], {}):
                compact[key] = truncate_text(source[key], 1800 if key.endswith("prompt") or key == "style_template" else 500)
        for key in ("items", "related", "selected_styles", "applied", "initialized_fields"):
            values = source.get(key)
            if not isinstance(values, list):
                continue
            compact[key] = [_compact_item(item) for item in values[:20]]
            compact[f"{key}_count"] = len(values)
    compact["preview"] = truncate_text(content, 1200)
    serialized = json_text(compact)
    if len(serialized) <= limit:
        return serialized
    fallback = {
        "ok": compact.get("ok"),
        "truncated": True,
        "original_chars": len(content),
        "sha256": compact["sha256"],
        "error": truncate_text(compact.get("error"), 500),
        "target": compact.get("target"),
        "kind": compact.get("kind"),
        "query": compact.get("query"),
        "prompt_hash": compact.get("prompt_hash"),
        "context_hash": compact.get("context_hash"),
        "preview": truncate_text(content, min(2000, max(200, limit // 2))),
    }
    return json_text({key: value for key, value in fallback.items() if value not in (None, "")})


def model_event_cost(event: dict[str, Any]) -> int:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    event_type = event.get("event_type")
    if event_type == "user_message":
        return max(1, (len(str(payload.get("content") or "")) + 3) // 4) + (1024 if payload.get("image") else 0)
    if event_type == "assistant_message":
        raw = str(payload.get("content") or "") + json_text(payload.get("tool_calls") or [])
        return max(1, (len(raw) + 3) // 4)
    if event_type == "tool_result":
        return max(1, (len(compact_tool_result(payload)) + 3) // 4)
    return 0


def events_to_units(events: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    results = {
        str(event.get("payload", {}).get("tool_call_id") or ""): event
        for event in events if event.get("event_type") == "tool_result"
    }
    consumed: set[str] = set()
    units: list[list[dict[str, Any]]] = []
    last_user: tuple[str, str, int] | None = None
    for event in events:
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        event_type = event.get("event_type")
        if event_type == "user_message":
            message: dict[str, Any] = {"role": "user", "content": str(payload.get("content") or "")}
            if payload.get("image"):
                message["image"] = payload["image"]
            if payload.get("filename"):
                message["filename"] = payload["filename"]
            signature = (str(event.get("run_id") or ""), message["content"])
            if last_user and signature == last_user[:2]:
                previous = units[last_user[2]][0]
                if previous.get("image") and not message.get("image"):
                    continue
                if message.get("image") and not previous.get("image"):
                    units[last_user[2]] = [message]
                    continue
            units.append([message])
            last_user = (signature[0], signature[1], len(units) - 1)
        elif event_type == "assistant_message":
            last_user = None
            calls = payload.get("tool_calls") if isinstance(payload.get("tool_calls"), list) else []
            unit = [{"role": "assistant", "content": str(payload.get("content") or ""), "tool_calls": calls}]
            for call in calls:
                call_id = str(call.get("id") or "") if isinstance(call, dict) else ""
                result_event = results.get(call_id)
                if not result_event:
                    continue
                result_payload = result_event.get("payload") or {}
                unit.append({"role": "tool", "tool_call_id": call_id, "content": compact_tool_result(result_payload)})
                consumed.add(call_id)
            units.append(unit)
        elif event_type == "tool_result":
            call_id = str(payload.get("tool_call_id") or "")
            if call_id and call_id not in consumed:
                continue
    return units


def select_recent_units(units: list[list[dict[str, Any]]], token_budget: int) -> list[dict[str, Any]]:
    selected: list[list[dict[str, Any]]] = []
    used = 0
    for unit in reversed(units):
        cost = sum(message_cost(message) for message in unit)
        if selected and used + cost > token_budget:
            break
        selected.append(unit)
        used += cost
    selected.reverse()
    return [message for unit in selected for message in unit]


def build_session_summary(events: list[dict[str, Any]], through_sequence: int) -> str:
    users = []
    outcomes = []
    tools = []
    last_user_signature: tuple[str, str] | None = None
    for event in events:
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        if event.get("event_type") == "user_message":
            signature = (str(event.get("run_id") or ""), str(payload.get("content") or ""))
            if signature == last_user_signature:
                continue
            users.append({
                "sequence": event.get("sequence"),
                "content": truncate_text(payload.get("content"), 1800),
                "attachment": str(payload.get("filename") or "")[:256],
            })
            last_user_signature = signature
        elif event.get("event_type") == "assistant_message" and str(payload.get("content") or "").strip():
            last_user_signature = None
            outcomes.append({"sequence": event.get("sequence"), "content": truncate_text(payload.get("content"), 1200)})
        elif event.get("event_type") == "tool_result":
            compact = _decode_object(compact_tool_result(payload, 2400))
            tools.append({
                "sequence": event.get("sequence"),
                "tool": str(payload.get("tool") or ""),
                "tool_call_id": str(payload.get("tool_call_id") or ""),
                "result": compact,
            })
    summary = {
        "version": 1,
        "covered_through_sequence": int(through_sequence),
        "initial_user_request": users[0] if users else None,
        "recent_user_requests": users[-12:],
        "recent_assistant_outcomes": outcomes[-8:],
        "recent_tool_facts": tools[-16:],
    }
    text = json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True)
    while len(text) > MAX_SUMMARY_CHARS:
        if len(summary["recent_tool_facts"]) > 4:
            summary["recent_tool_facts"].pop(0)
        elif len(summary["recent_assistant_outcomes"]) > 3:
            summary["recent_assistant_outcomes"].pop(0)
        elif len(summary["recent_user_requests"]) > 4:
            summary["recent_user_requests"].pop(0)
        else:
            for item in summary["recent_user_requests"]:
                item["content"] = truncate_text(item.get("content"), 700)
            for item in summary["recent_assistant_outcomes"]:
                item["content"] = truncate_text(item.get("content"), 500)
            break
        text = json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True)
    return json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True)


def message_cost(message: dict[str, Any]) -> int:
    raw = str(message.get("content") or "") + json_text(message.get("tool_calls") or [])
    return max(1, (len(raw) + 3) // 4) + (1024 if message.get("image") else 0)


def _compact_item(item: Any) -> Any:
    if not isinstance(item, dict):
        return truncate_text(item, 200)
    compact = {}
    for key in ("id", "name", "canonical_name", "prompt_tag", "category", "kind", "match", "description", "wiki_excerpt"):
        if item.get(key) not in (None, "", [], {}):
            compact[key] = truncate_text(item[key], 400)
    return compact or {"preview": truncate_text(json_text(item), 400)}


def _decode_object(value: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value) if value else {}
    except json.JSONDecodeError:
        return {"preview": truncate_text(value, 1200)}
    return parsed if isinstance(parsed, dict) else {"value": parsed}
