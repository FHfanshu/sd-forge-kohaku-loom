from __future__ import annotations

import asyncio
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.prompt_agent import API_PREFIX, register_prompt_agent_api
from backend.prompt_agent.forge_tools import (
    FORGE_TOOL_NAMES,
    ForgeTeacherError,
    ForgeToolValidationError,
    TeacherRequest,
    ask_teacher_once,
    execute_catalog_tool,
    validate_forge_tool_request,
)
from backend.prompt_agent.profiles import ProfileAuthority


class ForgeToolValidationTests(unittest.TestCase):
    def test_phase_six_names_are_fixed_and_ordered(self):
        self.assertEqual(
            (
                "read_prompt",
                "edit_prompt",
                "read_negative_prompt",
                "edit_negative_prompt",
                "list_resources",
                "read_resource_metadata",
                "ask_teacher",
                "read_generation_parameters",
                "apply_generation_parameters",
                "list_models",
                "list_loras",
                "list_embeddings",
            ),
            FORGE_TOOL_NAMES,
        )

    def test_server_owned_paths_and_bridge_fields_are_rejected(self):
        with self.assertRaisesRegex(ForgeToolValidationError, "server-owned"):
            validate_forge_tool_request("ask_teacher", {"question": "Review C:/private/model.gguf"})
        with self.assertRaisesRegex(ForgeToolValidationError, "server-owned"):
            validate_forge_tool_request("list_models", {"model_path": "C:/private/model.gguf"})
        with self.assertRaisesRegex(ForgeToolValidationError, "unsupported fields"):
            validate_forge_tool_request("read_prompt", {"target": "txt2img", "owner_id": "x"})

    def test_mutations_require_fresh_hashes_and_allowlisted_parameters(self):
        with self.assertRaisesRegex(ForgeToolValidationError, "base_hash"):
            validate_forge_tool_request("edit_prompt", {"patches": []})
        with self.assertRaisesRegex(ForgeToolValidationError, "context_hash"):
            validate_forge_tool_request("apply_generation_parameters", {"parameters": {}})
        with self.assertRaisesRegex(ForgeToolValidationError, "server-owned"):
            validate_forge_tool_request("apply_generation_parameters", {"context_hash": "h", "parameters": {"model": "x"}})

    def test_prompt_patches_and_generation_values_are_revalidated(self):
        with self.assertRaisesRegex(ForgeToolValidationError, r"patches\[0\] must be an object"):
            validate_forge_tool_request("edit_prompt", {"base_hash": "h", "patches": ["append text"]})
        with self.assertRaisesRegex(ForgeToolValidationError, "operation is invalid"):
            validate_forge_tool_request("edit_prompt", {"base_hash": "h", "patches": [{"operation": "write_file"}]})
        with self.assertRaisesRegex(ForgeToolValidationError, "allow_multiple must be a boolean"):
            validate_forge_tool_request("edit_prompt", {"base_hash": "h", "patches": [{"allow_multiple": "yes"}]})
        with self.assertRaisesRegex(ForgeToolValidationError, "steps must be an integer"):
            validate_forge_tool_request("apply_generation_parameters", {"context_hash": "h", "parameters": {"steps": 20.5}})
        with self.assertRaisesRegex(ForgeToolValidationError, "denoising_strength must be a number"):
            validate_forge_tool_request("apply_generation_parameters", {"context_hash": "h", "parameters": {"denoising_strength": 2}})
        with self.assertRaisesRegex(ForgeToolValidationError, "enable_hr must be a boolean"):
            validate_forge_tool_request("apply_generation_parameters", {"context_hash": "h", "parameters": {"enable_hr": 1}})

        result = validate_forge_tool_request("apply_generation_parameters", {
            "context_hash": "h",
            "parameters": {"steps": 20, "cfg_scale": 7.5, "enable_hr": False},
        })
        self.assertEqual(20, result["parameters"]["steps"])

    def test_catalog_projection_contains_logical_ids_only(self):
        with patch("backend.prompt_agent.forge_tools._model_catalog_items", return_value=[
            {"id": "model-a", "label": "Model A", "filename": "C:/private/model.gguf"},
        ]):
            result = execute_catalog_tool("list_models", {})
        self.assertEqual("model-a", result["items"][0]["id"])
        self.assertEqual({"id": "model-a", "label": "Model A"}, result["items"][0])
        self.assertNotIn("C:/private", str(result))


class ForgeToolApiTests(unittest.TestCase):
    def test_health_enables_forge_tools_and_api_returns_structured_validation_errors(self):
        with TemporaryDirectory() as directory:
            app = FastAPI()
            register_prompt_agent_api(app, ProfileAuthority(directory))
            client = TestClient(app)
            health = client.get(f"{API_PREFIX}/health")
            self.assertTrue(health.json()["features"]["forge_tools"])
            response = client.post(f"{API_PREFIX}/forge-tools", json={
                "tool": "list_models",
                "arguments": {"model_path": "C:/private/model.gguf"},
            })
        self.assertEqual(422, response.status_code)
        self.assertEqual("validation_error", response.json()["detail"]["error"]["code"])
        self.assertNotIn("C:/private", response.text)

    def test_validation_endpoint_revalidates_browser_host_tools(self):
        with TemporaryDirectory() as directory:
            app = FastAPI()
            register_prompt_agent_api(app, ProfileAuthority(directory))
            client = TestClient(app)
            accepted = client.post(f"{API_PREFIX}/forge-tools/validate", json={
                "tool": "edit_prompt",
                "arguments": {
                    "target": "txt2img",
                    "field": "positive",
                    "base_hash": "hash-1",
                    "patches": [{"operation": "append", "text": "rim light"}],
                },
            })
            rejected = client.post(f"{API_PREFIX}/forge-tools/validate", json={
                "tool": "apply_generation_parameters",
                "arguments": {
                    "context_hash": "hash-2",
                    "parameters": {"steps": 20.5},
                },
            })

        self.assertEqual(200, accepted.status_code)
        self.assertEqual("hash-1", accepted.json()["arguments"]["base_hash"])
        self.assertEqual(422, rejected.status_code)
        self.assertEqual("validation_error", rejected.json()["detail"]["error"]["code"])

    def test_teacher_endpoint_uses_selected_profile_without_browser_provider_fields(self):
        with TemporaryDirectory() as directory:
            authority = ProfileAuthority(directory)
            app = FastAPI()
            register_prompt_agent_api(app, authority)
            with patch("backend.prompt_agent.app.ask_teacher_once", new=AsyncMock(return_value={"ok": True, "text": "Use a stronger silhouette."})) as teacher:
                response = TestClient(app).post(f"{API_PREFIX}/forge-tools", json={
                    "tool": "ask_teacher",
                    "arguments": {"question": "How can I improve this prompt?", "context": "portrait"},
                })
        self.assertEqual(200, response.status_code)
        self.assertEqual("Use a stronger silhouette.", response.json()["text"])
        request = teacher.await_args.args[0]
        self.assertIsInstance(request, TeacherRequest)
        self.assertEqual("How can I improve this prompt?", request.question)
        serialized = str(teacher.await_args.args[1])
        self.assertNotIn("api_key", serialized)

    def test_teacher_endpoint_does_not_expose_upstream_error_text(self):
        with TemporaryDirectory() as directory:
            app = FastAPI()
            register_prompt_agent_api(app, ProfileAuthority(directory))
            private_error = "Bearer private-token C:/private/model.gguf"
            with patch("backend.prompt_agent.app.ask_teacher_once", new=AsyncMock(side_effect=ForgeTeacherError(private_error))):
                response = TestClient(app).post(f"{API_PREFIX}/forge-tools", json={
                    "tool": "ask_teacher",
                    "arguments": {"question": "How can I improve this prompt?"},
                })
        self.assertEqual(502, response.status_code)
        self.assertEqual("The selected teacher request failed.", response.json()["detail"]["error"]["message"])
        self.assertNotIn("private-token", response.text)
        self.assertNotIn("C:/private", response.text)


class TeacherProxyTests(unittest.TestCase):
    def test_teacher_proxy_is_one_bounded_adapter_request(self):
        class Adapter:
            id = "openai-compatible"

            async def stream(self, _request, _profile):
                yield 'data: {"type":"start"}\n\n'
                yield 'data: {"type":"text_delta","delta":"Answer"}\n\n'
                yield 'data: {"type":"done"}\n\n'

        profile = {
            "profile_id": "teacher",
            "enabled": True,
            "runtime": "remote-http",
            "protocol": "openai-chat-completions",
            "endpoint": "https://teacher.invalid/v1",
            "model_id": "teacher-model",
            "parameters": {"timeout": 2, "max_tokens": 100},
        }
        with patch("backend.prompt_agent.forge_tools.adapter_for_profile", return_value=Adapter()):
            result = asyncio.run(ask_teacher_once(TeacherRequest("Question", "SAFE_SLOT_001", ""), profile))
        self.assertEqual("Answer", result["text"])
        self.assertEqual("openai-compatible", result["provider_id"])


if __name__ == "__main__":
    unittest.main()
