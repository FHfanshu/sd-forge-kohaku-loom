from __future__ import annotations

import json
import re
import threading
from typing import Any

from .assistant import prompt_assistant_chat
from .assistant_profiles import LLAMA_ENDPOINT, LLAMA_ONCE, OPENAI_CHAT_COMPLETIONS
from .session_context import MAX_SUMMARY_CHARS, truncate_text


DEFAULT_SESSION_TITLE = "New session"


def local_session_profile(model_snapshot: dict[str, Any]) -> dict[str, Any] | None:
    profile = model_snapshot.get("session_profile") if isinstance(model_snapshot, dict) else None
    if not isinstance(profile, dict):
        return None
    profile_id = str(model_snapshot.get("session_profile_id") or profile.get("profile_id") or "").strip()
    runtime = str(profile.get("runtime") or "").strip()
    if not profile_id or str(profile.get("profile_id") or "").strip() != profile_id:
        return None
    if runtime not in {LLAMA_ENDPOINT, LLAMA_ONCE} or profile.get("protocol") != OPENAI_CHAT_COMPLETIONS:
        return None
    return dict(profile)


def deterministic_session_title(user_text: str) -> str:
    text = re.sub(r"\s+", " ", str(user_text or "")).strip()
    text = re.sub(r"^[#>*\-\s]+", "", text)
    return truncate_text(text, 72) or DEFAULT_SESSION_TITLE


def generate_session_title(model_snapshot: dict[str, Any], user_text: str, assistant_text: str = "") -> str:
    fallback = deterministic_session_title(user_text)
    profile = local_session_profile(model_snapshot)
    if not profile:
        return fallback
    prompt = (
        "Create a short title for this assistant session. Return only the title, with no quotes, markdown, "
        "label, or ending punctuation. Use the user's language and keep it under 60 characters.\n\n"
        f"User request:\n{truncate_text(user_text, 4000)}"
    )
    if assistant_text:
        prompt += f"\n\nAssistant outcome:\n{truncate_text(assistant_text, 2500)}"
    try:
        result = prompt_assistant_chat(_metadata_payload(profile, prompt, 96))
        title = re.sub(r"\s+", " ", str(result.get("text") or "")).strip().strip("\"'`#* ")
        title = re.sub(r"[.!?。！？:：;；]+$", "", title).strip()
        return truncate_text(title, 80) or fallback
    except Exception:  # noqa: BLE001
        return fallback


def generate_session_summary(model_snapshot: dict[str, Any], deterministic_summary: str) -> str:
    profile = local_session_profile(model_snapshot)
    if not profile:
        return deterministic_summary
    prompt = (
        "Summarize the durable state of this long-running assistant session. Preserve user goals, decisions, "
        "constraints, completed work, important tool findings, unresolved issues, and the next useful action. "
        "Do not invent facts. Return plain text only, under 3000 characters.\n\n"
        f"Structured session facts:\n{deterministic_summary}"
    )
    try:
        result = prompt_assistant_chat(_metadata_payload(profile, prompt, 1200))
        narrative = truncate_text(result.get("text"), 3000)
        if not narrative:
            return deterministic_summary
        parsed = json.loads(deterministic_summary)
        if not isinstance(parsed, dict) or int(parsed.get("version") or 0) != 1:
            return deterministic_summary
        parsed["model_summary"] = narrative
        parsed["metadata_profile_id"] = profile["profile_id"]
        text = json.dumps(parsed, ensure_ascii=False, indent=2, sort_keys=True)
        if len(text) <= MAX_SUMMARY_CHARS:
            return text
        parsed["model_summary"] = truncate_text(narrative, max(200, 3000 - (len(text) - MAX_SUMMARY_CHARS)))
        text = json.dumps(parsed, ensure_ascii=False, indent=2, sort_keys=True)
        return text if len(text) <= MAX_SUMMARY_CHARS else deterministic_summary
    except Exception:  # noqa: BLE001
        return deterministic_summary


def schedule_session_title(repository: Any, session_id: str) -> None:
    try:
        session = repository.get_session(session_id)
        if session.get("title") != DEFAULT_SESSION_TITLE:
            return
        events = repository.events(session_id, limit=1000)
        user = next((event for event in events if event.get("event_type") == "user_message"), None)
        if not user:
            return
        assistant = next((event for event in events if event.get("event_type") == "assistant_message"), None)
        args = (
            repository,
            session,
            str(user.get("payload", {}).get("content") or ""),
            str(assistant.get("payload", {}).get("content") or "") if assistant else "",
        )
        if local_session_profile(session.get("model_snapshot") or {}):
            threading.Thread(target=_refresh_session_title, args=args, daemon=True, name="q3vl-session-title").start()
        else:
            _refresh_session_title(*args)
    except Exception:  # noqa: BLE001
        return


def schedule_session_summary(repository: Any, session_id: str, through_sequence: int, deterministic_summary: str, model_snapshot: dict[str, Any]) -> None:
    if not local_session_profile(model_snapshot):
        return
    threading.Thread(
        target=_refresh_session_summary,
        args=(repository, session_id, through_sequence, deterministic_summary, model_snapshot),
        daemon=True,
        name="q3vl-session-summary",
    ).start()


def _refresh_session_title(repository: Any, session: dict[str, Any], user_text: str, assistant_text: str) -> None:
    try:
        title = generate_session_title(session.get("model_snapshot") or {}, user_text, assistant_text)
        current = repository.get_session(session["session_id"])
        if current.get("title") == DEFAULT_SESSION_TITLE:
            repository.update_session(session["session_id"], title=title, version=current.get("version"))
    except Exception:  # noqa: BLE001
        return


def _refresh_session_summary(repository: Any, session_id: str, through_sequence: int, deterministic_summary: str, model_snapshot: dict[str, Any]) -> None:
    try:
        summary = generate_session_summary(model_snapshot, deterministic_summary)
        if summary != deterministic_summary:
            repository.replace_summary_if_current(session_id, through_sequence, deterministic_summary, summary)
    except Exception:  # noqa: BLE001
        return


def _metadata_payload(profile: dict[str, Any], prompt: str, max_tokens: int) -> dict[str, Any]:
    payload = dict(profile)
    payload.update({
        "messages": [{"role": "user", "content": prompt}],
        "disable_tools": True,
        "stream": False,
        "thinking": False,
        "temperature": 0.15,
        "top_p": 0.9,
        "max_tokens": max_tokens,
        "run_id": "",
    })
    return payload
