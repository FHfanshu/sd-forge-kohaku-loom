from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any

from .assistant_sessions import default_session_database


class LegacySessionReader:
    def __init__(self, database: str | Path | None = None):
        self.database = Path(database or default_session_database()).resolve()

    @property
    def available(self) -> bool:
        return self.database.is_file()

    def list_sessions(self, limit: int = 50) -> list[dict[str, Any]]:
        if not self.available:
            return []
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT session_id,title,created_at,updated_at,state,profile_id,summary "
                "FROM agent_sessions ORDER BY updated_at DESC LIMIT ?",
                (max(1, min(int(limit), 200)),),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_session(self, session_id: str, limit: int = 500) -> dict[str, Any]:
        if not self.available:
            raise FileNotFoundError(self.database)
        with closing(self._connect()) as connection:
            session = connection.execute(
                "SELECT session_id,title,created_at,updated_at,state,profile_id,summary "
                "FROM agent_sessions WHERE session_id=?",
                (str(session_id or ""),),
            ).fetchone()
            if session is None:
                raise KeyError(session_id)
            rows = connection.execute(
                "SELECT sequence,event_type,created_at,payload_json FROM agent_events "
                "WHERE session_id=? AND event_type IN "
                "('user_message','user_followup_queued','assistant_message','tool_result','error') "
                "ORDER BY sequence LIMIT ?",
                (session_id, max(1, min(int(limit), 1000))),
            ).fetchall()
        events = []
        for row in rows:
            try:
                payload = json.loads(row["payload_json"])
            except (TypeError, ValueError):
                payload = {}
            events.append(
                {
                    "sequence": row["sequence"],
                    "event_type": row["event_type"],
                    "created_at": row["created_at"],
                    "payload": payload if isinstance(payload, dict) else {},
                }
            )
        return {"session": dict(session), "events": events, "read_only": True}

    def _connect(self) -> sqlite3.Connection:
        uri = f"file:{self.database.as_posix()}?mode=ro"
        connection = sqlite3.connect(uri, uri=True, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only = ON")
        return connection
