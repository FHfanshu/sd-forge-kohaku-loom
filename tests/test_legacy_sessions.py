from __future__ import annotations

import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from kohaku_loom.assistant_sessions import AssistantSessionRepository
from kohaku_loom.legacy_sessions import LegacySessionReader


class LegacySessionReaderTests(unittest.TestCase):
    def test_missing_database_is_an_empty_read_only_source(self):
        with tempfile.TemporaryDirectory() as directory:
            reader = LegacySessionReader(Path(directory) / "missing.sqlite3")
            self.assertEqual([], reader.list_sessions())

    def test_reader_lists_and_replays_without_mutating_database(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "sessions.sqlite3"
            repository = AssistantSessionRepository(database)
            session = repository.create_session("Old chat")
            repository.append_event(session["session_id"], "user_message", {"content": "hello"})
            repository.append_event(session["session_id"], "assistant_message", {"content": "world"})
            before = database.read_bytes()

            reader = LegacySessionReader(database)
            listed = reader.list_sessions()
            restored = reader.get_session(session["session_id"])

            self.assertEqual("Old chat", listed[0]["title"])
            self.assertEqual(["hello", "world"], [event["payload"]["content"] for event in restored["events"]])
            self.assertTrue(restored["read_only"])
            self.assertEqual(before, database.read_bytes())
            with closing(reader._connect()) as connection:
                with self.assertRaises(sqlite3.OperationalError):
                    connection.execute("UPDATE agent_sessions SET title='changed'")


if __name__ == "__main__":
    unittest.main()
