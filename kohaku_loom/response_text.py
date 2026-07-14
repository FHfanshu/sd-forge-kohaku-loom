from __future__ import annotations

import json
import re
from typing import Any


def reasoning_text(fields: Any) -> str:
    if isinstance(fields, str):
        return fields
    if isinstance(fields, list):
        return "".join(reasoning_text(item) for item in fields)
    if not isinstance(fields, dict):
        return ""
    direct = fields.get("reasoning_content") or fields.get("reasoning")
    if isinstance(direct, str) and direct:
        return direct
    details = fields.get("reasoning_details")
    if isinstance(details, list):
        return "".join(
            str(item.get("text") or item.get("thinking") or "")
            for item in details
            if isinstance(item, dict)
        )
    return ""


def _response_text_utf8(response: requests.Response) -> str:
    return response.content.decode("utf-8", errors="replace")


def _response_json_utf8(response: requests.Response) -> Any:
    return json.loads(_response_text_utf8(response))
def _mojibake_score(text: str) -> int:
    cjk = sum(1 for char in text if "\u4e00" <= char <= "\u9fff")
    markers = sum(text.count(marker) for marker in ("Ã", "Â", "å", "æ", "ç", "ä", "ã"))
    controls = sum(1 for char in text if 0x80 <= ord(char) <= 0x9F)
    replacement = text.count("\ufffd")
    return cjk * 3 - markers * 2 - controls * 2 - replacement * 4


def _repair_mojibake_text(text: str) -> str:
    if not text or "\ufffd" in text:
        return text
    if not any(marker in text for marker in ("Ã", "Â", "å", "æ", "ç", "ä", "ã")):
        return text
    try:
        repaired = text.encode("latin-1").decode("utf-8")
    except UnicodeError:
        return text
    return repaired if _mojibake_score(repaired) > _mojibake_score(text) else text


def _clean_response_text(text: Any) -> str:
    if isinstance(text, list):
        parts = []
        for item in text:
            if isinstance(item, dict):
                if str(item.get("type") or "") in {"tool_use", "tool_call", "function_call"}:
                    continue
                value = item.get("text", item.get("content", ""))
            else:
                value = item
            if value:
                parts.append(str(value))
        text = "\n".join(parts)
    text = re.sub(r"<think>.*?</think>", "", str(text), flags=re.DOTALL | re.IGNORECASE)
    text = text.replace("<|im_end|>", "").replace("<|endoftext|>", "")
    text = _repair_mojibake_text(text)
    return text.strip().strip('"')


def _extract_message_text(message: dict[str, Any]) -> str:
    text = _clean_response_text(message.get("content", ""))
    if text:
        return text
    reasoning = _clean_response_text(message.get("reasoning_content") or message.get("reasoning") or "")
    if reasoning:
        raise RuntimeError(
            "模型只返回了 reasoning_content，没有最终答案。请关闭 '启用 thinking'，或显著提高 Max tokens 后重试。"
        )
    raise RuntimeError("模型返回了空结果。请降低模板复杂度、提高 Max tokens，或换 9B/4B 模型重试。")
