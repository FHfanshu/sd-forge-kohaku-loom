import base64
import io
import json
import tempfile
import time
import unittest
from contextlib import closing
from unittest import mock
from pathlib import Path

from PIL import Image

from kohaku_loom.assistant_sessions import AssistantSessionRepository, AssistantSessionService, SessionConflict
from kohaku_loom.session_metadata import generate_session_summary, generate_session_title


class AssistantSessionRepositoryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.repository = AssistantSessionRepository(Path(self.directory.name) / "sessions.sqlite3")

    def tearDown(self):
        self.directory.cleanup()

    def test_migration_and_events_survive_repository_restart(self):
        session = self.repository.create_session("Test session", "profile-a", {"model": "test"})
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "Hello"}])
        self.repository.record_turn(run["run_id"], {"text": "Hi", "tool_calls": []}, 1)
        self.repository.checkpoint(run["run_id"], "completed", "final response")

        restored = AssistantSessionRepository(self.repository.database)
        loaded = restored.get_session(session["session_id"])
        events = restored.events(session["session_id"])
        self.assertEqual("completed", loaded["state"])
        self.assertEqual(["user_message", "assistant_message", "checkpoint", "run_completed"], [event["event_type"] for event in events])
        self.assertEqual(list(range(1, len(events) + 1)), [event["sequence"] for event in events])

    def test_running_lease_prevents_duplicate_run_owner(self):
        session = self.repository.create_session()
        self.repository.start_run(session["session_id"], [{"role": "user", "content": "first"}], lease_owner="tab-a")
        with self.assertRaises(SessionConflict):
            self.repository.start_run(session["session_id"], [{"role": "user", "content": "second"}], lease_owner="tab-b")

    def test_stream_claim_is_single_use_and_owner_bound(self):
        session = self.repository.create_session()
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "first"}], lease_owner="tab-a")
        claimed = self.repository.claim_run(run["run_id"], "tab-a")
        self.assertEqual("running", claimed["status"])
        with self.assertRaises(SessionConflict):
            self.repository.claim_run(run["run_id"], "tab-a")

    def test_expired_run_is_fenced_before_replacement_starts(self):
        session = self.repository.create_session()
        first = self.repository.start_run(session["session_id"], [{"role": "user", "content": "first"}], lease_owner="tab-a", lease_seconds=1)
        time.sleep(1.05)
        second = self.repository.start_run(session["session_id"], [{"role": "user", "content": "second"}], lease_owner="tab-b")
        self.assertEqual("interrupted", self.repository.get_run(first["run_id"])["status"])
        with self.assertRaises(SessionConflict):
            self.repository.record_turn(first["run_id"], {"text": "late", "tool_calls": []}, 1)
        self.repository.checkpoint(first["run_id"], "completed", "late completion")
        loaded = self.repository.get_session(session["session_id"])
        self.assertEqual(second["run_id"], loaded["active_run_id"])
        self.assertEqual("running", loaded["state"])

    def test_cancelled_run_rejects_late_turn_and_terminal_overwrite(self):
        session = self.repository.create_session()
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "first"}])
        self.repository.checkpoint(run["run_id"], "cancelled", "cancelled by user")
        with self.assertRaises(SessionConflict):
            self.repository.record_turn(run["run_id"], {"text": "late", "tool_calls": []}, 1)
        loaded = self.repository.checkpoint(run["run_id"], "completed", "late completion")
        self.assertEqual("cancelled", loaded["status"])

    def test_session_stream_uses_database_run_id_for_local_cancellation(self):
        session = self.repository.create_session()
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "first"}], lease_owner="tab-a")
        captured = {}

        def stream(payload):
            captured.update(payload)
            yield '{"type":"done","text":"ok","tool_calls":[]}\n'

        service = AssistantSessionService(self.repository)
        with mock.patch("kohaku_loom.assistant_sessions.prompt_assistant_stream", stream):
            list(service.stream(run["run_id"], {"lease_owner": "tab-a", "timeout": 10}))
        self.assertEqual(run["run_id"], captured["run_id"])

    def test_waiting_run_can_receive_result_and_resume(self):
        session = self.repository.create_session()
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "read"}])
        self.repository.record_turn(
            run["run_id"],
            {"text": "", "tool_calls": [{"id": "call-1", "tool": "read_prompt", "arguments": {}}]},
            1,
        )
        self.repository.checkpoint(run["run_id"], "waiting", "awaiting tool results")
        event = self.repository.append_tool_result(run["run_id"], {"tool_call_id": "call-1", "content": "result"})
        resumed = self.repository.resume_run(run["run_id"], "tab-a")
        self.assertEqual("tool_result", event["event_type"])
        self.assertEqual("running", resumed["status"])

    def test_session_images_are_validated_and_normalized_before_storage(self):
        buffer = io.BytesIO()
        Image.new("RGB", (16, 16), "red").save(buffer, format="PNG")
        data_url = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
        session = self.repository.create_session()
        self.repository.start_run(session["session_id"], [{"role": "user", "content": "image", "image": data_url}])
        event = self.repository.events(session["session_id"])[0]
        self.assertTrue(event["payload"]["image"].startswith("data:image/jpeg;base64,"))
        invalid_session = self.repository.create_session()
        with self.assertRaisesRegex(RuntimeError, "invalid reference image data"):
            self.repository.start_run(invalid_session["session_id"], [{"role": "user", "image": "data:image/png;base64,not-base64"}])

    def test_session_snapshot_is_sanitized_at_repository_boundary(self):
        session = self.repository.create_session(
            model_snapshot={"api_key": "secret", "nested": {"authorization": "bearer", "model": "safe"}}
        )
        self.assertEqual({"nested": {"model": "safe"}}, session["model_snapshot"])

    def test_session_search_matches_title_summary_user_and_final_assistant_messages(self):
        title = self.repository.create_session("Copper portrait")
        summary = self.repository.create_session("Summary search")
        user = self.repository.create_session("User search")
        assistant = self.repository.create_session("Assistant search")
        intermediate = self.repository.create_session("Intermediate search")
        with closing(self.repository._connect()) as connection:
            connection.execute("UPDATE agent_sessions SET summary=? WHERE session_id=?", ("durable apricot fact", summary["session_id"]))
        user_run = self.repository.start_run(user["session_id"], [{"role": "user", "content": "find cobalt lighting"}])
        self.repository.record_turn(user_run["run_id"], {"text": "done", "tool_calls": []}, 1)
        assistant_run = self.repository.start_run(assistant["session_id"], [{"role": "user", "content": "request"}])
        self.repository.record_turn(assistant_run["run_id"], {"text": "final vermilion result", "tool_calls": []}, 1)
        intermediate_run = self.repository.start_run(intermediate["session_id"], [{"role": "user", "content": "request"}])
        self.repository.record_turn(intermediate_run["run_id"], {"text": "hidden chartreuse", "tool_calls": [{"id": "x", "tool": "read_prompt", "arguments": {}}]}, 1)

        self.assertEqual([title["session_id"]], [item["session_id"] for item in self.repository.search_sessions("copper")])
        self.assertEqual([summary["session_id"]], [item["session_id"] for item in self.repository.search_sessions("apricot")])
        self.assertEqual([user["session_id"]], [item["session_id"] for item in self.repository.search_sessions("cobalt")])
        self.assertEqual([assistant["session_id"]], [item["session_id"] for item in self.repository.search_sessions("vermilion")])
        self.assertEqual([], self.repository.search_sessions("chartreuse"))

    def test_session_metadata_uses_local_profile_and_falls_back_deterministically(self):
        snapshot = {
            "session_profile_id": "local-meta",
            "session_profile": {
                "profile_id": "local-meta", "protocol": "openai-chat-completions", "runtime": "llama-endpoint",
                "endpoint": "http://127.0.0.1:8080/v1", "model": "local-model", "parameters": {},
            },
        }
        deterministic = json.dumps({"version": 1, "covered_through_sequence": 10})
        with mock.patch("kohaku_loom.session_metadata.prompt_assistant_chat", return_value={"text": "Local title."}) as chat:
            self.assertEqual("Local title", generate_session_title(snapshot, "A long user request"))
            payload = chat.call_args.args[0]
            self.assertEqual("local-meta", payload["profile_id"])
            self.assertTrue(payload["disable_tools"])
            self.assertFalse(payload["thinking"])
        with mock.patch("kohaku_loom.session_metadata.prompt_assistant_chat", return_value={"text": "Keep the copper decision."}):
            summary = json.loads(generate_session_summary(snapshot, deterministic))
            self.assertEqual("Keep the copper decision.", summary["model_summary"])
            self.assertEqual("local-meta", summary["metadata_profile_id"])
        with mock.patch("kohaku_loom.session_metadata.prompt_assistant_chat", side_effect=RuntimeError("offline")):
            self.assertEqual("A long user request", generate_session_title(snapshot, "A long user request"))
            self.assertEqual(deterministic, generate_session_summary(snapshot, deterministic))

    def test_context_keeps_tool_call_and_result_together(self):
        session = self.repository.create_session()
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "x" * 1200}])
        self.repository.record_turn(
            run["run_id"],
            {"text": "", "tool_calls": [{"id": "call-1", "tool": "read_prompt", "arguments": {}}]},
            1,
        )
        self.repository.checkpoint(run["run_id"], "waiting", "awaiting tool results")
        self.repository.append_tool_result(run["run_id"], {"tool_call_id": "call-1", "content": "tool payload"})
        messages = self.repository.context_messages(session["session_id"], token_budget=2048, reserve_tokens=0)
        assistant = next(message for message in messages if message["role"] == "assistant")
        tool = next(message for message in messages if message["role"] == "tool")
        self.assertEqual("call-1", assistant["tool_calls"][0]["id"])
        self.assertEqual("call-1", tool["tool_call_id"])

    def test_missing_provider_tool_id_receives_stable_local_id(self):
        session = self.repository.create_session()
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "read"}])
        self.repository.record_turn(run["run_id"], {"text": "", "tool_calls": [{"tool": "read_prompt", "arguments": {}}]}, 1)
        self.repository.checkpoint(run["run_id"], "waiting", "awaiting tool results")
        self.repository.append_tool_result(run["run_id"], {"tool_call_id": "call_1_0", "content": "result"})
        messages = self.repository.context_messages(session["session_id"], token_budget=2048, reserve_tokens=0)
        self.assertEqual("call_1_0", next(item for item in messages if item["role"] == "tool")["tool_call_id"])

    def test_cancellation_records_resumable_checkpoint(self):
        session = self.repository.create_session()
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "wait"}])
        self.repository.checkpoint(run["run_id"], "cancelled", "cancelled by user")
        loaded = self.repository.get_run(run["run_id"])
        events = self.repository.events(session["session_id"])
        self.assertEqual("cancelled", loaded["status"])
        self.assertIn("cancelled", [event["event_type"] for event in events])

    def test_duplicate_tool_result_id_is_idempotent(self):
        session = self.repository.create_session()
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "wait"}])
        self.repository.checkpoint(run["run_id"], "waiting", "awaiting tool results")
        payload = {"tool_call_id": "call-1", "content": "result"}
        first = self.repository.append_tool_result(run["run_id"], payload)
        second = self.repository.append_tool_result(run["run_id"], payload)
        events = self.repository.events(session["session_id"])
        self.assertEqual(first["event_id"], second["event_id"])
        self.assertEqual(1, sum(event["event_type"] == "tool_result" for event in events))

    def test_followup_after_current_tool_supersedes_remaining_calls(self):
        session = self.repository.create_session()
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "start"}])
        self.repository.record_turn(
            run["run_id"],
            {
                "text": "",
                "tool_calls": [
                    {"id": "call-a", "tool": "read_prompt", "arguments": {}},
                    {"id": "call-b", "tool": "edit_prompt", "arguments": {}},
                    {"id": "call-c", "tool": "inspect_resource", "arguments": {}},
                ],
            },
            1,
        )
        self.repository.checkpoint(run["run_id"], "waiting", "awaiting tool results")
        self.assertEqual("execute", self.repository.prepare_tool_call(run["run_id"], "call-a")["next_action"])
        queued = self.repository.queue_followups(run["run_id"], [{"role": "user", "content": "use a left composition"}])
        self.assertEqual("queued", queued["next_action"])

        result = self.repository.append_tool_result(
            run["run_id"],
            {"tool_call_id": "call-a", "tool": "read_prompt", "content": "{}", "result": {"ok": True}},
        )
        self.assertEqual("replan", result["next_action"])
        self.assertEqual(["call-b", "call-c"], result["superseded_tool_call_ids"])
        messages = self.repository.context_messages(session["session_id"], token_budget=4096, reserve_tokens=0)
        self.assertEqual("use a left composition", messages[-1]["content"])
        tool_results = [message for message in messages if message["role"] == "tool"]
        self.assertEqual(["call-a", "call-b", "call-c"], [message["tool_call_id"] for message in tool_results])

    def test_followup_before_tool_start_replans_without_executing_it(self):
        session = self.repository.create_session()
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "start"}])
        self.repository.record_turn(
            run["run_id"],
            {"text": "", "tool_calls": [{"id": "call-a", "tool": "read_prompt", "arguments": {}}]},
            1,
        )
        self.repository.checkpoint(run["run_id"], "waiting", "awaiting tool results")
        queued = self.repository.queue_followups(run["run_id"], [{"role": "user", "content": "changed request"}])
        self.assertEqual("replan", queued["next_action"])
        prepared = self.repository.prepare_tool_call(run["run_id"], "call-a")
        self.assertEqual("skip", prepared["next_action"])

    def test_followup_reopens_completed_run(self):
        session = self.repository.create_session()
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "start"}])
        self.repository.record_turn(run["run_id"], {"text": "done", "tool_calls": []}, 1)
        self.repository.finalize_turn(run["run_id"], False)
        queued = self.repository.queue_followups(run["run_id"], [{"role": "user", "content": "one more change"}])
        self.assertEqual("replan", queued["next_action"])
        self.assertEqual("waiting", self.repository.get_run(run["run_id"])["status"])
        self.assertEqual(run["run_id"], self.repository.get_session(session["session_id"])["active_run_id"])

    def test_followup_rejects_more_than_six_images(self):
        session = self.repository.create_session()
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "start"}])
        with self.assertRaisesRegex(ValueError, "at most 6 images"):
            self.repository.queue_followups(run["run_id"], [{"role": "user", "image": "x"} for _ in range(7)])

    def test_followup_during_final_model_turn_prevents_completion(self):
        session = self.repository.create_session()
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "start"}], lease_owner="tab-a")

        def stream(_payload):
            self.repository.queue_followups(run["run_id"], [{"role": "user", "content": "change the ending"}])
            yield '{"type":"done","text":"old final","tool_calls":[]}\n'

        service = AssistantSessionService(self.repository)
        with mock.patch("kohaku_loom.assistant_sessions.prompt_assistant_stream", stream):
            output = list(service.stream(run["run_id"], {"lease_owner": "tab-a", "timeout": 10}))
        self.assertTrue(any('"next_action": "replan"' in item for item in output))
        self.assertEqual("waiting", self.repository.get_run(run["run_id"])["status"])
        self.assertEqual("change the ending", self.repository.context_messages(session["session_id"])[-1]["content"])

    def test_context_uses_latest_model_events_after_more_than_one_thousand_events(self):
        session = self.repository.create_session()
        for index in range(1005):
            self.repository.append_event(session["session_id"], "checkpoint", {"index": index}, visibility="audit")
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "latest request"}])
        messages = self.repository.context_messages(session["session_id"])
        self.assertEqual("latest request", messages[-1]["content"])
        self.assertEqual(run["run_id"], self.repository.get_session(session["session_id"])["active_run_id"])

    def test_long_session_is_compacted_into_durable_summary(self):
        session = self.repository.create_session()
        for index in range(7):
            run = self.repository.start_run(session["session_id"], [{"role": "user", "content": f"request {index} " + "x" * 3000}])
            self.repository.record_turn(run["run_id"], {"text": f"answer {index}", "tool_calls": []}, 1)
            self.repository.finalize_turn(run["run_id"], False)
        messages = self.repository.context_messages(session["session_id"], token_budget=4096, reserve_tokens=0)
        loaded = self.repository.get_session(session["session_id"])
        self.assertGreater(loaded["summary_through_sequence"], 0)
        self.assertIn("request 0", loaded["summary"])
        self.assertEqual(1, json.loads(loaded["summary"])["version"])
        self.assertEqual("system", messages[0]["role"])
        self.assertIn("Durable session summary", messages[0]["content"])
        self.assertEqual("answer 6", messages[-1]["content"])

    def test_large_tool_result_is_compacted_and_keeps_exchange_complete(self):
        session = self.repository.create_session()
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "search"}])
        self.repository.record_turn(
            run["run_id"],
            {"text": "", "tool_calls": [{"id": "call-large", "tool": "search_danbooru_tags", "arguments": {"query": "x"}}]},
            1,
        )
        self.repository.checkpoint(run["run_id"], "waiting", "awaiting tool results")
        content = json.dumps({"ok": True, "query": "x", "items": [{"name": "tag", "description": "z" * 1000}] * 40})
        self.repository.append_tool_result(run["run_id"], {"tool_call_id": "call-large", "tool": "search_danbooru_tags", "content": content})
        messages = self.repository.context_messages(session["session_id"], token_budget=4096, reserve_tokens=0)
        assistant = next(item for item in messages if item["role"] == "assistant")
        tool = next(item for item in messages if item["role"] == "tool")
        self.assertEqual("call-large", assistant["tool_calls"][0]["id"])
        self.assertEqual("call-large", tool["tool_call_id"])
        self.assertLess(len(tool["content"]), 8000)
        self.assertIn('"truncated":true', tool["content"])

    def test_event_page_returns_latest_semantic_events(self):
        session = self.repository.create_session()
        for index in range(600):
            self.repository.append_event(session["session_id"], "assistant_delta", {"text": str(index)}, visibility="ui")
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "tail message"}])
        self.repository.record_turn(run["run_id"], {"text": "tail answer", "tool_calls": []}, 1)
        page = self.repository.event_page(session["session_id"], limit=20)
        self.assertEqual(["user_message", "assistant_message"], [item["event_type"] for item in page["events"]])
        self.assertEqual("tail message", page["events"][0]["payload"]["content"])
        self.assertEqual("tail answer", page["events"][1]["payload"]["content"])

    def test_service_deduplicates_image_message_and_repeated_plain_text(self):
        session = self.repository.create_session()
        service = AssistantSessionService(self.repository)
        image = "data:image/png;base64," + base64.b64encode(self._png_bytes()).decode("ascii")
        service.start(session["session_id"], {
            "messages": [
                {"role": "user", "content": "same request", "image": image, "filename": "image.png"},
                {"role": "user", "content": "same request"},
            ]
        })
        users = [event for event in self.repository.events(session["session_id"]) if event["event_type"] == "user_message"]
        self.assertEqual(1, len(users))
        self.assertTrue(users[0]["payload"].get("image"))

    def test_context_deduplicates_legacy_image_and_plain_text_pair(self):
        session = self.repository.create_session()
        run = self.repository.start_run(session["session_id"], [{"role": "user", "content": "placeholder"}])
        self.repository.append_event(session["session_id"], "user_message", {"content": "same", "image": "data:image/jpeg;base64,x"}, run_id=run["run_id"], visibility="model", turn_id=0)
        self.repository.append_event(session["session_id"], "user_message", {"content": "same"}, run_id=run["run_id"], visibility="model", turn_id=0)
        messages = self.repository.context_messages(session["session_id"])
        users = [message for message in messages if message["role"] == "user" and message["content"] == "same"]
        self.assertEqual(1, len(users))
        self.assertTrue(users[0].get("image"))

    @staticmethod
    def _png_bytes():
        buffer = io.BytesIO()
        Image.new("RGB", (8, 8), "blue").save(buffer, format="PNG")
        return buffer.getvalue()

    def test_optimistic_session_update_rejects_stale_version(self):
        session = self.repository.create_session("Old")
        self.repository.update_session(session["session_id"], title="New", version=session["version"])
        with self.assertRaises(SessionConflict):
            self.repository.update_session(session["session_id"], title="Stale", version=session["version"])


if __name__ == "__main__":
    unittest.main()
