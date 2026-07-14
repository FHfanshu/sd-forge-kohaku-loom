from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
import uuid
from contextlib import closing
from pathlib import Path
from typing import Any, Iterator

from .assistant import prompt_assistant_stream
from .image_payloads import _image_data_url, _image_from_data_url
from .session_context import build_session_summary, events_to_units, model_event_cost, select_recent_units
from .session_metadata import schedule_session_summary, schedule_session_title

SESSION_STATES = {"idle", "running", "waiting", "interrupted", "completed", "failed", "archived"}
RUN_STATES = {"running", "waiting", "interrupted", "completed", "failed", "cancelled"}
EVENT_TYPES = {
    "user_message", "assistant_delta", "reasoning_delta", "assistant_message", "tool_call", "tool_result",
    "user_followup_queued", "user_followup_activated", "tool_call_started", "tool_call_superseded",
    "ui_mutation", "usage", "checkpoint", "summary", "error", "cancelled", "run_completed",
}
VISIBILITIES = {"model", "ui", "audit"}
DEFAULT_TURN_GUARD = 32
MAX_SESSION_MESSAGE_CHARS = 1_000_000
MAX_SESSION_IMAGES = 6
MAX_SESSION_IMAGE_DATA_CHARS = 64 * 1024 * 1024
SUMMARY_KEEP_COMPLETED_RUNS = 4
SUMMARY_EVENT_THRESHOLD = 400


class SessionConflict(RuntimeError):
    pass


class SessionNotFound(RuntimeError):
    pass


def default_session_database() -> Path:
    return Path(__file__).resolve().parents[1] / "data" / "assistant_sessions.sqlite3"


def _now() -> float:
    return time.time()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _decode(value: str | None, fallback: Any) -> Any:
    try:
        return json.loads(value) if value else fallback
    except json.JSONDecodeError:
        return fallback


def _event_hash(event_type: str, payload: dict[str, Any]) -> str:
    return hashlib.sha256((event_type + "\0" + _json(payload)).encode("utf-8")).hexdigest()


def _normalized_user_message(message: dict[str, Any]) -> dict[str, Any]:
    content = str(message.get("content") or "")
    if len(content) > MAX_SESSION_MESSAGE_CHARS:
        raise ValueError("user message is too large")
    payload: dict[str, Any] = {"content": content}
    filename = str(message.get("filename") or "")
    if filename:
        payload["filename"] = filename[:512]
    image_data = message.get("image")
    if image_data:
        image = _image_from_data_url(str(image_data))
        try:
            payload["image"] = _image_data_url(image, max_side=2048)
        finally:
            image.close()
    return payload


def _validate_user_message_batch(messages: list[dict[str, Any]]) -> None:
    images = [str(message.get("image") or "") for message in messages if isinstance(message, dict) and message.get("image")]
    if len(images) > MAX_SESSION_IMAGES:
        raise ValueError(f"at most {MAX_SESSION_IMAGES} images are allowed per message batch")
    if sum(len(image) for image in images) > MAX_SESSION_IMAGE_DATA_CHARS:
        raise ValueError("image attachments exceed the 48 MB total limit")


def _public_session(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "session_id": row["session_id"],
        "title": row["title"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "archived_at": row["archived_at"],
        "state": row["state"],
        "active_run_id": row["active_run_id"],
        "profile_id": row["profile_id"],
        "model_snapshot": _decode(row["model_snapshot_json"], {}),
        "summary": row["summary"] or "",
        "summary_through_sequence": row["summary_through_sequence"] or 0,
        "version": row["version"],
    }


def _public_run(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "run_id": row["run_id"],
        "session_id": row["session_id"],
        "status": row["status"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
        "user_request_event_id": row["user_request_event_id"],
        "turn_count": row["turn_count"],
        "tool_call_count": row["tool_call_count"],
        "input_tokens": row["input_tokens"],
        "output_tokens": row["output_tokens"],
        "reasoning_tokens": row["reasoning_tokens"],
        "cached_tokens": row["cached_tokens"],
        "stop_reason": row["stop_reason"] or "",
        "error": _decode(row["error_json"], None),
        "lease_expires_at": row["lease_expires_at"],
        "active_tool_call_id": row["active_tool_call_id"] or "",
    }


class AssistantSessionRepository:
    """SQLite-backed append-only assistant sessions.

    A connection is opened per operation so the repository is safe for Forge request
    workers and remains usable after a backend restart.
    """

    def __init__(self, database: str | Path | None = None):
        self.database = Path(database or default_session_database())
        self.database.parent.mkdir(parents=True, exist_ok=True)
        self._migration_lock = threading.Lock()
        self.migrate()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(str(self.database), timeout=15, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    def migrate(self) -> None:
        with self._migration_lock, closing(self._connect()) as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS agent_sessions (
                    session_id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    archived_at REAL,
                    state TEXT NOT NULL,
                    active_run_id TEXT,
                    profile_id TEXT NOT NULL DEFAULT '',
                    model_snapshot_json TEXT NOT NULL DEFAULT '{}',
                    summary TEXT NOT NULL DEFAULT '',
                    summary_through_sequence INTEGER NOT NULL DEFAULT 0,
                    version INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE IF NOT EXISTS agent_runs (
                    run_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
                    status TEXT NOT NULL,
                    started_at REAL NOT NULL,
                    finished_at REAL,
                    user_request_event_id TEXT,
                    turn_count INTEGER NOT NULL DEFAULT 0,
                    tool_call_count INTEGER NOT NULL DEFAULT 0,
                    input_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0,
                    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
                    cached_tokens INTEGER NOT NULL DEFAULT 0,
                    stop_reason TEXT NOT NULL DEFAULT '',
                    error_json TEXT,
                    lease_owner TEXT NOT NULL DEFAULT '',
                    lease_expires_at REAL NOT NULL DEFAULT 0,
                    active_tool_call_id TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS agent_events (
                    event_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
                    run_id TEXT REFERENCES agent_runs(run_id) ON DELETE SET NULL,
                    sequence INTEGER NOT NULL,
                    turn_id INTEGER,
                    event_type TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    payload_json TEXT NOT NULL,
                    visibility TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    UNIQUE(session_id, sequence)
                );
                CREATE INDEX IF NOT EXISTS agent_sessions_recent ON agent_sessions(archived_at, updated_at DESC);
                CREATE INDEX IF NOT EXISTS agent_runs_session ON agent_runs(session_id, started_at DESC);
                CREATE INDEX IF NOT EXISTS agent_events_replay ON agent_events(session_id, sequence);
                """
            )
            columns = {row["name"] for row in connection.execute("PRAGMA table_info(agent_runs)").fetchall()}
            if "active_tool_call_id" not in columns:
                connection.execute("ALTER TABLE agent_runs ADD COLUMN active_tool_call_id TEXT NOT NULL DEFAULT ''")

    def create_session(self, title: str = "", profile_id: str = "", model_snapshot: dict[str, Any] | None = None) -> dict[str, Any]:
        now = _now()
        session_id = uuid.uuid4().hex
        with closing(self._connect()) as connection:
            connection.execute(
                "INSERT INTO agent_sessions(session_id,title,created_at,updated_at,state,profile_id,model_snapshot_json) VALUES(?,?,?,?,?,?,?)",
                (session_id, str(title or "New session").strip() or "New session", now, now, "idle", str(profile_id or ""), _json(sanitized_model_snapshot(model_snapshot or {}))),
            )
        return self.get_session(session_id)

    def get_session(self, session_id: str) -> dict[str, Any]:
        with closing(self._connect()) as connection:
            row = connection.execute("SELECT * FROM agent_sessions WHERE session_id = ?", (session_id,)).fetchone()
        if row is None:
            raise SessionNotFound("session not found")
        return _public_session(row)

    def list_sessions(self, include_archived: bool = False, limit: int = 50) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 200))
        query = "SELECT * FROM agent_sessions"
        if not include_archived:
            query += " WHERE archived_at IS NULL"
        query += " ORDER BY updated_at DESC LIMIT ?"
        with closing(self._connect()) as connection:
            rows = connection.execute(query, (limit,)).fetchall()
        return [_public_session(row) for row in rows]

    def search_sessions(self, query: str, include_archived: bool = False, limit: int = 50) -> list[dict[str, Any]]:
        value = str(query or "").strip()[:500]
        if not value:
            return self.list_sessions(include_archived, limit)
        limit = max(1, min(int(limit), 200))
        pattern = "%" + value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        archived = "" if include_archived else "s.archived_at IS NULL AND "
        sql = f"""
            SELECT s.* FROM agent_sessions AS s
            WHERE {archived}(
                s.title LIKE ? ESCAPE '\\' OR s.summary LIKE ? ESCAPE '\\' OR EXISTS (
                    SELECT 1 FROM agent_events AS e
                    WHERE e.session_id=s.session_id
                      AND (e.event_type='user_message' OR (
                          e.event_type='assistant_message'
                          AND COALESCE(json_array_length(json_extract(e.payload_json, '$.tool_calls')), 0)=0
                      ))
                      AND COALESCE(json_extract(e.payload_json, '$.content'), '') LIKE ? ESCAPE '\\'
                )
            )
            ORDER BY s.updated_at DESC LIMIT ?
        """
        with closing(self._connect()) as connection:
            rows = connection.execute(sql, (pattern, pattern, pattern, limit)).fetchall()
        return [_public_session(row) for row in rows]

    def update_session(self, session_id: str, *, title: str | None = None, archived: bool | None = None, version: int | None = None) -> dict[str, Any]:
        now = _now()
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT * FROM agent_sessions WHERE session_id = ?", (session_id,)).fetchone()
            if row is None:
                raise SessionNotFound("session not found")
            if version is not None and int(row["version"]) != int(version):
                raise SessionConflict("session version conflict")
            next_title = str(title).strip() if title is not None else row["title"]
            next_archived_at = (now if archived else None) if archived is not None else row["archived_at"]
            next_state = "archived" if archived else ("idle" if row["state"] == "archived" else row["state"])
            connection.execute(
                "UPDATE agent_sessions SET title=?, archived_at=?, state=?, updated_at=?, version=version+1 WHERE session_id=?",
                (next_title or "New session", next_archived_at, next_state, now, session_id),
            )
            connection.commit()
        return self.get_session(session_id)

    def replace_summary_if_current(self, session_id: str, through_sequence: int, expected_summary: str, summary: str) -> bool:
        with closing(self._connect()) as connection:
            result = connection.execute(
                "UPDATE agent_sessions SET summary=?,updated_at=?,version=version+1 WHERE session_id=? AND summary_through_sequence=? AND summary=?",
                (summary, _now(), session_id, int(through_sequence), expected_summary),
            )
        return result.rowcount == 1

    def delete_session(self, session_id: str) -> None:
        with closing(self._connect()) as connection:
            result = connection.execute("DELETE FROM agent_sessions WHERE session_id = ?", (session_id,))
            if result.rowcount != 1:
                raise SessionNotFound("session not found")

    def get_run(self, run_id: str) -> dict[str, Any]:
        with closing(self._connect()) as connection:
            row = connection.execute("SELECT * FROM agent_runs WHERE run_id = ?", (run_id,)).fetchone()
        if row is None:
            raise SessionNotFound("run not found")
        return _public_run(row)

    def _append_event_txn(
        self, connection: sqlite3.Connection, session_id: str, run_id: str | None, event_type: str,
        payload: dict[str, Any], visibility: str, turn_id: int | None = None,
    ) -> dict[str, Any]:
        if event_type not in EVENT_TYPES:
            raise ValueError(f"unsupported event type: {event_type}")
        if visibility not in VISIBILITIES:
            raise ValueError(f"unsupported event visibility: {visibility}")
        row = connection.execute("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM agent_events WHERE session_id = ?", (session_id,)).fetchone()
        now = _now()
        event = {
            "event_id": uuid.uuid4().hex,
            "session_id": session_id,
            "run_id": run_id,
            "sequence": int(row["sequence"]),
            "turn_id": turn_id,
            "event_type": event_type,
            "created_at": now,
            "payload": payload,
            "visibility": visibility,
        }
        connection.execute(
            "INSERT INTO agent_events(event_id,session_id,run_id,sequence,turn_id,event_type,created_at,payload_json,visibility,content_hash) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (event["event_id"], session_id, run_id, event["sequence"], turn_id, event_type, now, _json(payload), visibility, _event_hash(event_type, payload)),
        )
        connection.execute("UPDATE agent_sessions SET updated_at=?, version=version+1 WHERE session_id=?", (now, session_id))
        return event

    def append_event(
        self, session_id: str, event_type: str, payload: dict[str, Any], *, run_id: str | None = None,
        visibility: str = "model", turn_id: int | None = None,
    ) -> dict[str, Any]:
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            if connection.execute("SELECT 1 FROM agent_sessions WHERE session_id=?", (session_id,)).fetchone() is None:
                raise SessionNotFound("session not found")
            if run_id and event_type in {"assistant_delta", "reasoning_delta", "error"}:
                run = connection.execute("SELECT session_id,status FROM agent_runs WHERE run_id=?", (run_id,)).fetchone()
                if run is None or run["session_id"] != session_id:
                    raise SessionNotFound("run not found")
                if run["status"] != "running":
                    raise SessionConflict("run is not running")
            event = self._append_event_txn(connection, session_id, run_id, event_type, payload, visibility, turn_id)
            connection.commit()
        return event

    def events(self, session_id: str, after_sequence: int = 0, limit: int = 500) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 1000))
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT * FROM agent_events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?",
                (session_id, max(0, int(after_sequence)), limit),
            ).fetchall()
        return [
            {
                "event_id": row["event_id"], "session_id": row["session_id"], "run_id": row["run_id"],
                "sequence": row["sequence"], "turn_id": row["turn_id"], "event_type": row["event_type"],
                "created_at": row["created_at"], "payload": _decode(row["payload_json"], {}), "visibility": row["visibility"],
            }
            for row in rows
        ]

    def latest_events(self, session_id: str, limit: int = 500, before_sequence: int | None = None) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 1000))
        upper = int(before_sequence) if before_sequence is not None else 2**63 - 1
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT * FROM agent_events WHERE session_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?",
                (session_id, upper, limit),
            ).fetchall()
        rows.reverse()
        return [self._public_event(row) for row in rows]

    def event_page(self, session_id: str, limit: int = 500, before_sequence: int | None = None) -> dict[str, Any]:
        limit = max(1, min(int(limit), 1000))
        upper = int(before_sequence) if before_sequence is not None else 2**63 - 1
        with closing(self._connect()) as connection:
            rows = connection.execute(
                """
                SELECT * FROM agent_events
                WHERE session_id=? AND sequence<?
                  AND event_type NOT IN ('assistant_delta','reasoning_delta','usage','tool_call','tool_call_started')
                ORDER BY sequence DESC LIMIT ?
                """,
                (session_id, upper, limit + 1),
            ).fetchall()
            row = connection.execute(
                "SELECT COALESCE(MAX(sequence),0) latest_sequence FROM agent_events WHERE session_id=?",
                (session_id,),
            ).fetchone()
        has_more = len(rows) > limit
        rows = rows[:limit]
        rows.reverse()
        events = [self._public_event(item) for item in rows]
        return {
            "events": events,
            "has_more": has_more,
            "before_sequence": events[0]["sequence"] if has_more and events else None,
            "latest_sequence": int(row["latest_sequence"]),
        }

    @staticmethod
    def _public_event(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "event_id": row["event_id"], "session_id": row["session_id"], "run_id": row["run_id"],
            "sequence": row["sequence"], "turn_id": row["turn_id"], "event_type": row["event_type"],
            "created_at": row["created_at"], "payload": _decode(row["payload_json"], {}), "visibility": row["visibility"],
        }

    def start_run(
        self, session_id: str, user_messages: list[dict[str, Any]], profile_id: str = "", model_snapshot: dict[str, Any] | None = None,
        lease_owner: str = "", lease_seconds: int = 90,
    ) -> dict[str, Any]:
        if not user_messages:
            raise ValueError("user_messages is required")
        _validate_user_message_batch(user_messages)
        now = _now()
        run_id = uuid.uuid4().hex
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            session = connection.execute("SELECT * FROM agent_sessions WHERE session_id=?", (session_id,)).fetchone()
            if session is None:
                raise SessionNotFound("session not found")
            if session["state"] == "archived":
                raise SessionConflict("archived session cannot start a run")
            active = session["active_run_id"]
            if active:
                existing = connection.execute("SELECT status, lease_expires_at FROM agent_runs WHERE run_id=?", (active,)).fetchone()
                if existing and existing["status"] == "waiting":
                    raise SessionConflict("session has a resumable run")
                if existing and existing["status"] == "running" and existing["lease_expires_at"] > now:
                    raise SessionConflict("session already has a running lease")
                if existing and existing["status"] == "running":
                    connection.execute(
                        "UPDATE agent_runs SET status='interrupted',finished_at=?,stop_reason='run lease expired',lease_owner='',lease_expires_at=0 WHERE run_id=?",
                        (now, active),
                    )
            connection.execute(
                "INSERT INTO agent_runs(run_id,session_id,status,started_at,lease_owner,lease_expires_at) VALUES(?,?,?,?,?,?)",
                (run_id, session_id, "running", now, lease_owner or uuid.uuid4().hex, now + max(1, lease_seconds)),
            )
            last_event = None
            for message in user_messages:
                content = message.get("content") if isinstance(message, dict) else ""
                if not str(content or "").strip() and not (isinstance(message, dict) and message.get("image")):
                    continue
                payload = _normalized_user_message(message)
                last_event = self._append_event_txn(connection, session_id, run_id, "user_message", payload, "model", 0)
            if last_event is None:
                raise ValueError("user_messages is empty")
            snapshot = _json(sanitized_model_snapshot(model_snapshot or _decode(session["model_snapshot_json"], {})))
            connection.execute(
                "UPDATE agent_sessions SET state='running',active_run_id=?,profile_id=?,model_snapshot_json=?,updated_at=?,version=version+1 WHERE session_id=?",
                (run_id, profile_id or session["profile_id"], snapshot, now, session_id),
            )
            connection.execute("UPDATE agent_runs SET user_request_event_id=? WHERE run_id=?", (last_event["event_id"], run_id))
            connection.commit()
        return self.get_run(run_id)

    def resume_run(self, run_id: str, lease_owner: str = "", lease_seconds: int = 90) -> dict[str, Any]:
        now = _now()
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT * FROM agent_runs WHERE run_id=?", (run_id,)).fetchone()
            if row is None:
                raise SessionNotFound("run not found")
            if row["status"] not in {"waiting", "interrupted", "cancelled"}:
                raise SessionConflict("run is not resumable")
            connection.execute(
                "UPDATE agent_runs SET status='running',finished_at=NULL,stop_reason='',error_json=NULL,lease_owner=?,lease_expires_at=? WHERE run_id=?",
                (lease_owner or uuid.uuid4().hex, now + max(1, lease_seconds), run_id),
            )
            connection.execute(
                "UPDATE agent_sessions SET state='running',active_run_id=?,updated_at=?,version=version+1 WHERE session_id=?",
                (run_id, now, row["session_id"]),
            )
            connection.commit()
        return self.get_run(run_id)

    def claim_run(self, run_id: str, lease_owner: str, lease_seconds: int = 90) -> dict[str, Any]:
        owner = str(lease_owner or "").strip()
        if not owner:
            raise SessionConflict("lease owner is required")
        now = _now()
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            run = connection.execute("SELECT * FROM agent_runs WHERE run_id=?", (run_id,)).fetchone()
            if run is None:
                raise SessionNotFound("run not found")
            if run["status"] != "running":
                raise SessionConflict("run is not running")
            if run["lease_owner"] != owner or run["lease_expires_at"] <= now:
                raise SessionConflict("run lease is invalid or expired")
            updated = connection.execute(
                "UPDATE agent_runs SET lease_owner='',lease_expires_at=? WHERE run_id=? AND status='running' AND lease_owner=?",
                (now + max(1, lease_seconds), run_id, owner),
            )
            if updated.rowcount != 1:
                raise SessionConflict("run is already streaming")
            connection.commit()
        return self.get_run(run_id)

    def append_tool_result(self, run_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            run = connection.execute("SELECT * FROM agent_runs WHERE run_id=?", (run_id,)).fetchone()
            if run is None:
                raise SessionNotFound("run not found")
            if run["status"] not in {"waiting", "running"}:
                raise SessionConflict("run cannot accept a tool result")
            tool_call_id = str(payload.get("tool_call_id") or "").strip()
            if tool_call_id:
                existing = connection.execute(
                    "SELECT * FROM agent_events WHERE run_id=? AND event_type='tool_result' AND json_extract(payload_json, '$.tool_call_id')=?",
                    (run_id, tool_call_id),
                ).fetchone()
                if existing is not None:
                    activation = self._activate_followups_txn(connection, run_id)
                    connection.commit()
                    return {
                        "event_id": existing["event_id"], "session_id": existing["session_id"], "run_id": existing["run_id"],
                        "sequence": existing["sequence"], "turn_id": existing["turn_id"], "event_type": existing["event_type"],
                        "created_at": existing["created_at"], "payload": _decode(existing["payload_json"], {}), "visibility": existing["visibility"],
                        **activation,
                    }
            event = self._append_event_txn(connection, run["session_id"], run_id, "tool_result", payload, "model", int(run["turn_count"]))
            connection.execute("UPDATE agent_runs SET active_tool_call_id='' WHERE run_id=?", (run_id,))
            activation = self._activate_followups_txn(connection, run_id)
            connection.commit()
        return {**event, **activation}

    def queue_followups(self, run_id: str, messages: list[dict[str, Any]]) -> dict[str, Any]:
        if not messages:
            raise ValueError("followup messages are required")
        _validate_user_message_batch(messages)
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            run = connection.execute("SELECT * FROM agent_runs WHERE run_id=?", (run_id,)).fetchone()
            if run is None:
                raise SessionNotFound("run not found")
            if run["status"] not in {"running", "waiting", "completed"}:
                raise SessionConflict("run cannot accept followups")
            queued = []
            for message in messages:
                normalized = _normalized_user_message(message)
                if not normalized.get("content") and not normalized.get("image"):
                    continue
                queued.append(self._append_event_txn(
                    connection, run["session_id"], run_id, "user_followup_queued",
                    {"message": normalized}, "ui", int(run["turn_count"]),
                ))
            if not queued:
                raise ValueError("followup messages are empty")
            activation = {"next_action": "queued", "activated_followups": 0, "superseded_tool_call_ids": []}
            if run["status"] in {"waiting", "completed"} and not str(run["active_tool_call_id"] or ""):
                if run["status"] == "completed":
                    connection.execute(
                        "UPDATE agent_runs SET status='waiting',finished_at=NULL,stop_reason='',active_tool_call_id='' WHERE run_id=?",
                        (run_id,),
                    )
                    connection.execute(
                        "UPDATE agent_sessions SET state='waiting',active_run_id=?,updated_at=?,version=version+1 WHERE session_id=?",
                        (run_id, _now(), run["session_id"]),
                    )
                activation = self._activate_followups_txn(connection, run_id)
            connection.commit()
        return {"queued": len(queued), **activation}

    def prepare_tool_call(self, run_id: str, tool_call_id: str) -> dict[str, Any]:
        call_id = str(tool_call_id or "").strip()
        if not call_id:
            raise ValueError("tool_call_id is required")
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            run = connection.execute("SELECT * FROM agent_runs WHERE run_id=?", (run_id,)).fetchone()
            if run is None:
                raise SessionNotFound("run not found")
            if run["status"] not in {"waiting", "running"}:
                raise SessionConflict("run cannot start a tool call")
            active = str(run["active_tool_call_id"] or "")
            if active and active != call_id:
                raise SessionConflict("another tool call is already running")
            activation = self._activate_followups_txn(connection, run_id)
            if activation["next_action"] == "replan":
                connection.commit()
                return activation
            if self._tool_result_exists_txn(connection, run_id, call_id):
                connection.commit()
                return {"next_action": "skip", "tool_call_id": call_id}
            if not self._tool_call_exists_txn(connection, run_id, call_id):
                raise SessionConflict("tool call is not pending")
            connection.execute("UPDATE agent_runs SET active_tool_call_id=? WHERE run_id=?", (call_id, run_id))
            self._append_event_txn(connection, run["session_id"], run_id, "tool_call_started", {"tool_call_id": call_id}, "audit", int(run["turn_count"]))
            connection.commit()
        return {"next_action": "execute", "tool_call_id": call_id}

    def activate_pending_followups(self, run_id: str) -> dict[str, Any]:
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            result = self._activate_followups_txn(connection, run_id)
            connection.commit()
        return result

    def _pending_followups_txn(self, connection: sqlite3.Connection, run_id: str) -> list[sqlite3.Row]:
        return connection.execute(
            """
            SELECT queued.* FROM agent_events AS queued
            WHERE queued.run_id=? AND queued.event_type='user_followup_queued'
              AND NOT EXISTS (
                  SELECT 1 FROM agent_events AS activated
                  WHERE activated.run_id=queued.run_id
                    AND activated.event_type='user_followup_activated'
                    AND json_extract(activated.payload_json, '$.source_event_id')=queued.event_id
              )
            ORDER BY queued.sequence
            """,
            (run_id,),
        ).fetchall()

    def _tool_result_exists_txn(self, connection: sqlite3.Connection, run_id: str, tool_call_id: str) -> bool:
        return connection.execute(
            "SELECT 1 FROM agent_events WHERE run_id=? AND event_type='tool_result' AND json_extract(payload_json, '$.tool_call_id')=?",
            (run_id, tool_call_id),
        ).fetchone() is not None

    def _tool_call_exists_txn(self, connection: sqlite3.Connection, run_id: str, tool_call_id: str) -> bool:
        return connection.execute(
            "SELECT 1 FROM agent_events WHERE run_id=? AND event_type='tool_call' AND json_extract(payload_json, '$.id')=?",
            (run_id, tool_call_id),
        ).fetchone() is not None

    def _activate_followups_txn(self, connection: sqlite3.Connection, run_id: str) -> dict[str, Any]:
        run = connection.execute("SELECT * FROM agent_runs WHERE run_id=?", (run_id,)).fetchone()
        if run is None:
            raise SessionNotFound("run not found")
        if str(run["active_tool_call_id"] or ""):
            return {"next_action": "continue_tools", "activated_followups": 0, "superseded_tool_call_ids": []}
        pending = self._pending_followups_txn(connection, run_id)
        if not pending:
            return {"next_action": "continue_tools", "activated_followups": 0, "superseded_tool_call_ids": []}

        superseded = []
        tool_rows = connection.execute(
            "SELECT payload_json FROM agent_events WHERE run_id=? AND event_type='tool_call' AND turn_id=? ORDER BY sequence",
            (run_id, int(run["turn_count"])),
        ).fetchall()
        for row in tool_rows:
            call = _decode(row["payload_json"], {})
            call_id = str(call.get("id") or "")
            if not call_id or self._tool_result_exists_txn(connection, run_id, call_id):
                continue
            payload = {
                "tool_call_id": call_id,
                "tool": str(call.get("tool") or call.get("name") or ""),
                "content": _json({"ok": False, "cancelled": True, "reason": "superseded_by_user_followup"}),
                "result": {"ok": False, "cancelled": True, "reason": "superseded_by_user_followup"},
            }
            self._append_event_txn(connection, run["session_id"], run_id, "tool_result", payload, "model", int(run["turn_count"]))
            self._append_event_txn(connection, run["session_id"], run_id, "tool_call_superseded", {"tool_call_id": call_id}, "audit", int(run["turn_count"]))
            superseded.append(call_id)

        for row in pending:
            queued = _decode(row["payload_json"], {})
            message = queued.get("message") if isinstance(queued.get("message"), dict) else {}
            self._append_event_txn(
                connection, run["session_id"], run_id, "user_message",
                {**message, "followup_event_id": row["event_id"]}, "model", int(run["turn_count"]),
            )
            self._append_event_txn(
                connection, run["session_id"], run_id, "user_followup_activated",
                {"source_event_id": row["event_id"]}, "audit", int(run["turn_count"]),
            )
        self._append_event_txn(
            connection, run["session_id"], run_id, "checkpoint",
            {"status": "waiting", "reason": "user followup pending"}, "audit", int(run["turn_count"]),
        )
        connection.execute("UPDATE agent_runs SET status='waiting',finished_at=NULL,stop_reason='user followup',active_tool_call_id='' WHERE run_id=?", (run_id,))
        connection.execute(
            "UPDATE agent_sessions SET state='waiting',active_run_id=?,updated_at=?,version=version+1 WHERE session_id=?",
            (run_id, _now(), run["session_id"]),
        )
        return {"next_action": "replan", "activated_followups": len(pending), "superseded_tool_call_ids": superseded}

    def checkpoint(self, run_id: str, status: str, reason: str, error: dict[str, Any] | None = None) -> dict[str, Any]:
        if status not in {"waiting", "interrupted", "failed", "cancelled", "completed"}:
            raise ValueError("invalid checkpoint status")
        session_state = "completed" if status == "completed" else ("failed" if status == "failed" else ("waiting" if status == "waiting" else "interrupted"))
        now = _now()
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            run = connection.execute("SELECT * FROM agent_runs WHERE run_id=?", (run_id,)).fetchone()
            if run is None:
                raise SessionNotFound("run not found")
            if run["status"] in {"completed", "failed", "cancelled"}:
                connection.commit()
                return self.get_run(run_id)
            if status != "cancelled" and run["status"] != "running":
                connection.commit()
                return self.get_run(run_id)
            payload = {"status": status, "reason": reason}
            if error:
                payload["error"] = error
            self._append_event_txn(connection, run["session_id"], run_id, "checkpoint", payload, "audit", int(run["turn_count"]))
            if status == "cancelled":
                self._append_event_txn(connection, run["session_id"], run_id, "cancelled", payload, "ui", int(run["turn_count"]))
            if status == "completed":
                self._append_event_txn(connection, run["session_id"], run_id, "run_completed", payload, "ui", int(run["turn_count"]))
            connection.execute(
                "UPDATE agent_runs SET status=?,finished_at=?,stop_reason=?,error_json=?,lease_expires_at=0 WHERE run_id=?",
                (status, now, reason, _json(error) if error else None, run_id),
            )
            active_run_id = run_id if status == "waiting" else None
            connection.execute(
                "UPDATE agent_sessions SET state=?,active_run_id=?,updated_at=?,version=version+1 WHERE session_id=? AND active_run_id=?",
                (session_state, active_run_id, now, run["session_id"], run_id),
            )
            connection.commit()
        return self.get_run(run_id)

    def finalize_turn(self, run_id: str, has_tool_calls: bool) -> dict[str, Any]:
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            activation = self._activate_followups_txn(connection, run_id)
            if activation["next_action"] == "replan":
                connection.commit()
                return activation
            run = connection.execute("SELECT * FROM agent_runs WHERE run_id=?", (run_id,)).fetchone()
            if run is None:
                raise SessionNotFound("run not found")
            if run["status"] != "running":
                connection.commit()
                return {"next_action": "stop", "status": run["status"]}
            status = "waiting" if has_tool_calls else "completed"
            reason = "awaiting tool results" if has_tool_calls else "final response"
            now = _now()
            self._append_event_txn(
                connection, run["session_id"], run_id, "checkpoint",
                {"status": status, "reason": reason}, "audit", int(run["turn_count"]),
            )
            if status == "completed":
                self._append_event_txn(
                    connection, run["session_id"], run_id, "run_completed",
                    {"status": status, "reason": reason}, "ui", int(run["turn_count"]),
                )
            connection.execute(
                "UPDATE agent_runs SET status=?,finished_at=?,stop_reason=?,lease_expires_at=0,active_tool_call_id='' WHERE run_id=?",
                (status, now if status == "completed" else None, reason, run_id),
            )
            connection.execute(
                "UPDATE agent_sessions SET state=?,active_run_id=?,updated_at=?,version=version+1 WHERE session_id=? AND active_run_id=?",
                ("waiting" if has_tool_calls else "completed", run_id if has_tool_calls else None, now, run["session_id"], run_id),
            )
            connection.commit()
        return {"next_action": "execute_tools" if has_tool_calls else "complete", "status": status}

    def record_turn(self, run_id: str, result: dict[str, Any], turn_id: int) -> list[dict[str, Any]]:
        text = str(result.get("text") or "")
        reasoning = str(result.get("reasoning") or "")
        raw_tool_calls = result.get("tool_calls") if isinstance(result.get("tool_calls"), list) else []
        tool_calls = [
            {**call, "id": str(call.get("id") or f"call_{turn_id}_{index}")}
            for index, call in enumerate(raw_tool_calls) if isinstance(call, dict)
        ]
        usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            run = connection.execute("SELECT * FROM agent_runs WHERE run_id=?", (run_id,)).fetchone()
            if run is None:
                raise SessionNotFound("run not found")
            if run["status"] != "running":
                raise SessionConflict("run is not running")
            events = []
            if reasoning:
                events.append(self._append_event_txn(connection, run["session_id"], run_id, "reasoning_delta", {"text": reasoning}, "ui", turn_id))
            message = {"content": text, "tool_calls": tool_calls}
            events.append(self._append_event_txn(connection, run["session_id"], run_id, "assistant_message", message, "model", turn_id))
            for call in tool_calls:
                events.append(self._append_event_txn(connection, run["session_id"], run_id, "tool_call", call, "audit", turn_id))
            if usage:
                events.append(self._append_event_txn(connection, run["session_id"], run_id, "usage", usage, "audit", turn_id))
            connection.execute(
                "UPDATE agent_runs SET turn_count=?,tool_call_count=tool_call_count+?,input_tokens=input_tokens+?,output_tokens=output_tokens+?,reasoning_tokens=reasoning_tokens+?,cached_tokens=cached_tokens+? WHERE run_id=?",
                (turn_id, len(tool_calls), int(usage.get("input_tokens") or 0), int(usage.get("output_tokens") or 0), int(usage.get("thought_tokens") or usage.get("reasoning_tokens") or 0), int(usage.get("cached_tokens") or 0), run_id),
            )
            connection.commit()
        return events

    def context_messages(self, session_id: str, token_budget: int = 32768, reserve_tokens: int = 4096) -> list[dict[str, Any]]:
        budget = max(1024, int(token_budget) - max(0, int(reserve_tokens)))
        self.compact_session_context(session_id, budget)
        session = self.get_session(session_id)
        source = self._model_events(session_id, int(session.get("summary_through_sequence") or 0))
        summary = str(session.get("summary") or "").strip()
        summary_message = {"role": "system", "content": "Durable session summary:\n" + summary} if summary else None
        summary_cost = max(0, (len(summary_message["content"]) + 3) // 4) if summary_message else 0
        messages = select_recent_units(events_to_units(source), max(1024, budget - summary_cost))
        return ([summary_message] if summary_message else []) + messages

    def compact_session_context(self, session_id: str, token_budget: int = 28672) -> dict[str, Any]:
        with closing(self._connect()) as connection:
            session = connection.execute("SELECT * FROM agent_sessions WHERE session_id=?", (session_id,)).fetchone()
            if session is None:
                raise SessionNotFound("session not found")
            through = int(session["summary_through_sequence"] or 0)
            existing_summary = str(session["summary"] or "")
            if through and existing_summary and not _valid_summary(existing_summary):
                covered_rows = connection.execute(
                    """
                    SELECT * FROM agent_events WHERE session_id=? AND sequence<=?
                      AND event_type IN ('user_message','assistant_message','tool_result')
                    ORDER BY sequence
                    """,
                    (session_id, through),
                ).fetchall()
                repaired = build_session_summary([self._public_event(row) for row in covered_rows], through)
                connection.execute("UPDATE agent_sessions SET summary=?,version=version+1 WHERE session_id=?", (repaired, session_id))
            rows = connection.execute(
                "SELECT * FROM agent_events WHERE session_id=? AND sequence>? ORDER BY sequence",
                (session_id, through),
            ).fetchall()
            events = [self._public_event(row) for row in rows]
            model_events = [event for event in events if event["visibility"] == "model"]
            cost = sum(model_event_cost(event) for event in model_events)
            if len(events) < SUMMARY_EVENT_THRESHOLD and cost <= token_budget:
                return {"compacted": False, "summary_through_sequence": through}

            completed = [event for event in events if event["event_type"] == "run_completed"]
            if len(completed) <= SUMMARY_KEEP_COMPLETED_RUNS:
                return {"compacted": False, "summary_through_sequence": through}
            cutoff = int(completed[-SUMMARY_KEEP_COMPLETED_RUNS - 1]["sequence"])
            covered_rows = connection.execute(
                """
                SELECT * FROM agent_events WHERE session_id=? AND sequence<=?
                  AND event_type IN ('user_message','assistant_message','tool_result')
                ORDER BY sequence
                """,
                (session_id, cutoff),
            ).fetchall()
            covered = [self._public_event(row) for row in covered_rows]
            summary = build_session_summary(covered, cutoff)
            snapshot = _decode(session["model_snapshot_json"], {})
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            current = connection.execute(
                "SELECT summary_through_sequence FROM agent_sessions WHERE session_id=?", (session_id,)
            ).fetchone()
            if current is None:
                raise SessionNotFound("session not found")
            if int(current["summary_through_sequence"] or 0) != through:
                connection.commit()
                return {"compacted": False, "summary_through_sequence": int(current["summary_through_sequence"] or 0)}
            now = _now()
            connection.execute(
                "UPDATE agent_sessions SET summary=?,summary_through_sequence=?,updated_at=?,version=version+1 WHERE session_id=?",
                (summary, cutoff, now, session_id),
            )
            self._append_event_txn(
                connection, session_id, None, "summary",
                {"through_sequence": cutoff, "sha256": hashlib.sha256(summary.encode("utf-8")).hexdigest()}, "audit",
            )
            connection.commit()
        schedule_session_summary(self, session_id, cutoff, summary, snapshot)
        return {"compacted": True, "summary_through_sequence": cutoff, "summary": summary}

    def _model_events(self, session_id: str, after_sequence: int = 0) -> list[dict[str, Any]]:
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT * FROM agent_events WHERE session_id=? AND sequence>? AND visibility='model' ORDER BY sequence",
                (session_id, max(0, int(after_sequence))),
            ).fetchall()
        return [self._public_event(row) for row in rows]


def sanitized_model_snapshot(payload: dict[str, Any]) -> dict[str, Any]:
    secret_fields = {"api_key", "authorization", "headers", "image", "data_url"}

    def sanitize(value: Any) -> Any:
        if isinstance(value, dict):
            return {
                key: sanitize(item) for key, item in value.items()
                if key not in secret_fields and not key.startswith("_") and key != "messages"
            }
        if isinstance(value, list):
            return [sanitize(item) for item in value]
        return value

    return sanitize(payload)


class AssistantSessionService:
    def __init__(self, repository: AssistantSessionRepository | None = None):
        self.repository = repository or AssistantSessionRepository()

    def start(self, session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        messages = payload.get("messages") if isinstance(payload.get("messages"), list) else []
        user_messages = [item for item in messages if isinstance(item, dict) and item.get("role") == "user"]
        if not user_messages and payload.get("user_message"):
            raw = payload["user_message"]
            user_messages = [raw if isinstance(raw, dict) else {"content": str(raw)}]
        user_messages = _deduplicate_user_messages(user_messages)
        return self.repository.start_run(
            session_id, user_messages, str(payload.get("profile_id") or ""), sanitized_model_snapshot(payload), str(payload.get("lease_owner") or ""),
        )

    def stream(self, run_id: str, payload: dict[str, Any]) -> Iterator[str]:
        parameters = payload.get("parameters") if isinstance(payload.get("parameters"), dict) else {}
        timeout = max(1, min(int(payload.get("timeout") or parameters.get("timeout") or 120), 3600))
        run = self.repository.claim_run(run_id, str(payload.get("lease_owner") or ""), timeout * 2 + 30)
        if int(run["turn_count"]) >= int(payload.get("max_turns") or DEFAULT_TURN_GUARD):
            self.repository.checkpoint(run_id, "waiting", "model turn safety budget reached")
            yield _ndjson("checkpoint", {"status": "waiting", "reason": "model turn safety budget reached"})
            return
        request = dict(payload)
        request["_session_context"] = True
        request["run_id"] = run_id
        request["messages"] = self.repository.context_messages(run["session_id"], int(payload.get("context_tokens") or 32768))
        text_parts: list[str] = []
        reasoning_parts: list[str] = []
        final: dict[str, Any] | None = None
        try:
            for raw in prompt_assistant_stream(request):
                event = _decode(raw, {})
                event_type = str(event.get("type") or "")
                if event_type == "delta":
                    text_parts.append(str(event.get("text") or ""))
                    self.repository.append_event(run["session_id"], "assistant_delta", {"text": event.get("text") or ""}, run_id=run_id, visibility="ui", turn_id=int(run["turn_count"]) + 1)
                elif event_type == "reasoning_delta":
                    reasoning_parts.append(str(event.get("text") or ""))
                    self.repository.append_event(run["session_id"], "reasoning_delta", {"text": event.get("text") or ""}, run_id=run_id, visibility="ui", turn_id=int(run["turn_count"]) + 1)
                elif event_type == "error":
                    raise RuntimeError(str(event.get("error") or "assistant stream failed"))
                elif event_type == "done":
                    final = dict(event)
                yield raw if raw.endswith("\n") else raw + "\n"
            final = final or {"text": "".join(text_parts), "reasoning": "".join(reasoning_parts), "tool_calls": []}
            final.setdefault("text", "".join(text_parts))
            final.setdefault("reasoning", "".join(reasoning_parts))
            final.setdefault("tool_calls", [])
            calls = final["tool_calls"] if isinstance(final["tool_calls"], list) else []
            if len(calls) > 64:
                self.repository.checkpoint(run_id, "waiting", "malformed response exceeds 64 tool calls")
                yield _ndjson("checkpoint", {"status": "waiting", "reason": "malformed response exceeds 64 tool calls"})
                return
            if self.repository.get_run(run_id)["status"] != "running":
                return
            self.repository.record_turn(run_id, final, int(run["turn_count"]) + 1)
            finalization = self.repository.finalize_turn(run_id, bool(calls))
            if finalization["next_action"] == "replan":
                yield _ndjson("checkpoint", finalization)
            elif finalization["next_action"] == "complete":
                schedule_session_title(self.repository, run["session_id"])
        except Exception as exc:  # noqa: BLE001
            current = self.repository.get_run(run_id)
            if current["status"] == "cancelled":
                return
            if current["status"] == "running":
                self.repository.append_event(run["session_id"], "error", {"error": str(exc)}, run_id=run_id, visibility="ui")
                self.repository.checkpoint(run_id, "interrupted", "recoverable backend failure", {"message": str(exc)})
            yield _ndjson("error", {"error": str(exc)})


def _ndjson(event_type: str, payload: dict[str, Any]) -> str:
    return json.dumps({"type": event_type, **payload}, ensure_ascii=False) + "\n"


def _deduplicate_user_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for message in messages:
        content = str(message.get("content") or "")
        duplicate_index = next((
            index for index, existing in enumerate(result)
            if str(existing.get("content") or "") == content
        ), None)
        if duplicate_index is None:
            result.append(message)
            continue
        existing = result[duplicate_index]
        if message.get("image") and not existing.get("image"):
            result[duplicate_index] = message
        elif message.get("image") and existing.get("image"):
            result.append(message)
    return result


def _valid_summary(value: str) -> bool:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return False
    return isinstance(parsed, dict) and int(parsed.get("version") or 0) == 1
