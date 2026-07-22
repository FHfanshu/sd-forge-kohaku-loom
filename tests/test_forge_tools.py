from __future__ import annotations

import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.prompt_agent import API_PREFIX, register_prompt_agent_api
from backend.prompt_agent.forge_tools import (
    FORGE_TOOL_NAMES,
    ForgeToolValidationError,
    execute_catalog_tool,
    validate_forge_tool_request,
)
from backend.prompt_agent.profiles import ProfileAuthority
from quality.acceptance import acceptance


class ForgeToolValidationTests(unittest.TestCase):
    @acceptance("AGENT-TOOLS-001@1", "surface")
    def test_agent_tool_names_are_fixed_and_ordered(self):
        self.assertEqual(
            (
                "read_prompt",
                "edit_prompt",
                "read_generation_parameters",
                "apply_generation_parameters",
                "search_resources",
                "inspect_resource",
                "search_danbooru_tags",
                "inspect_danbooru_tags",
                "related_danbooru_tags",
            ),
            FORGE_TOOL_NAMES,
        )
        self.assertNotIn("ask_teacher", FORGE_TOOL_NAMES)
        self.assertEqual(9, len(FORGE_TOOL_NAMES))

    def test_server_owned_paths_and_bridge_fields_are_rejected(self):
        with self.assertRaisesRegex(ForgeToolValidationError, "server-owned"):
            validate_forge_tool_request("search_resources", {"kind": "model", "model_path": "C:/private/model.gguf"})
        with self.assertRaisesRegex(ForgeToolValidationError, "unsupported fields"):
            validate_forge_tool_request("read_prompt", {"target": "txt2img", "owner_id": "x"})
        with self.assertRaisesRegex(ForgeToolValidationError, "unknown Forge tool"):
            validate_forge_tool_request("ask_teacher", {"question": "x"})
        with self.assertRaisesRegex(ForgeToolValidationError, "unknown Forge tool"):
            validate_forge_tool_request("read_negative_prompt", {})
        with self.assertRaisesRegex(ForgeToolValidationError, "field must be positive or negative"):
            validate_forge_tool_request("read_prompt", {})

    @acceptance("DATA-INTEGRITY-001@1", "freshness")
    def test_mutations_require_fresh_hashes_and_allowlisted_parameters(self):
        with self.assertRaisesRegex(ForgeToolValidationError, "base_hash"):
            validate_forge_tool_request("edit_prompt", {"field": "positive", "patches": []})
        with self.assertRaisesRegex(ForgeToolValidationError, "context_hash"):
            validate_forge_tool_request("apply_generation_parameters", {"parameters": {}})
        with self.assertRaisesRegex(ForgeToolValidationError, "server-owned"):
            validate_forge_tool_request("apply_generation_parameters", {"context_hash": "h", "parameters": {"model": "x"}})

    def test_prompt_patches_and_generation_values_are_revalidated(self):
        with self.assertRaisesRegex(ForgeToolValidationError, r"patches\[0\] must be an object"):
            validate_forge_tool_request("edit_prompt", {"field": "positive", "base_hash": "h", "patches": ["append text"]})
        with self.assertRaisesRegex(ForgeToolValidationError, "operation is invalid"):
            validate_forge_tool_request("edit_prompt", {"field": "positive", "base_hash": "h", "patches": [{"operation": "write_file"}]})
        with self.assertRaisesRegex(ForgeToolValidationError, "allow_multiple must be a boolean"):
            validate_forge_tool_request("edit_prompt", {"field": "positive", "base_hash": "h", "patches": [{"allow_multiple": "yes"}]})
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

    def test_edit_prompt_accepts_full_overwrite_only_as_standalone_prompt(self):
        accepted = validate_forge_tool_request("edit_prompt", {
            "field": "negative",
            "base_hash": "h",
            "negative_state_hash": "negative-state-1",
            "prompt": "solo, standing",
        })
        self.assertEqual("solo, standing", accepted["prompt"])
        self.assertEqual("negative", accepted["field"])
        self.assertEqual("negative-state-1", accepted["negative_state_hash"])
        with self.assertRaisesRegex(ForgeToolValidationError, "cannot be combined"):
            validate_forge_tool_request("edit_prompt", {
                "field": "positive",
                "base_hash": "h",
                "prompt": "solo",
                "patches": [{"operation": "append", "text": "light"}],
            })
        with self.assertRaisesRegex(ForgeToolValidationError, "require patches, diff, or prompt"):
            validate_forge_tool_request("edit_prompt", {"field": "positive", "base_hash": "h"})
        with self.assertRaisesRegex(ForgeToolValidationError, "field must be positive or negative"):
            validate_forge_tool_request("read_prompt", {"field": "both"})

    def test_danbooru_tool_arguments_are_validated(self):
        search = validate_forge_tool_request("search_danbooru_tags", {
            "queries": ["long hair", "school uniform"],
            "limit": 8,
        })
        self.assertEqual(2, len(search["queries"]))
        inspect = validate_forge_tool_request("inspect_danbooru_tags", {
            "names": ["1girl", "blue_eyes"],
            "include_wiki": False,
        })
        self.assertEqual(["1girl", "blue_eyes"], inspect["names"])
        with self.assertRaisesRegex(ForgeToolValidationError, "names must be a list"):
            validate_forge_tool_request("inspect_danbooru_tags", {"names": []})
        with self.assertRaisesRegex(ForgeToolValidationError, "query is required"):
            validate_forge_tool_request("search_danbooru_tags", {})

    def test_catalog_projection_contains_logical_ids_only(self):
        with patch("backend.prompt_agent.forge_tools._model_catalog_items", return_value=[
            {"id": "model-a", "label": "Model A", "filename": "C:/private/model.gguf"},
        ]):
            result = execute_catalog_tool("search_resources", {"kind": "model"})
        self.assertEqual("model-a", result["items"][0]["id"])
        self.assertEqual({"id": "model-a", "label": "Model A"}, result["items"][0])
        self.assertNotIn("C:/private", str(result))
        with patch("backend.prompt_agent.forge_tools._model_catalog_items", return_value=[
            {"id": "model-a", "label": "Model A", "filename": "C:/private/model.gguf"},
        ]):
            inspected = execute_catalog_tool("inspect_resource", {"kind": "model", "id": "model-a"})
        self.assertEqual({"ok": True, "kind": "model", "id": "model-a", "label": "Model A"}, inspected)


class ForgeToolApiTests(unittest.TestCase):
    def test_health_enables_forge_tools_and_validation_returns_structured_errors(self):
        with TemporaryDirectory() as directory:
            app = FastAPI()
            register_prompt_agent_api(app, ProfileAuthority(directory))
            client = TestClient(app)
            health = client.get(f"{API_PREFIX}/health")
            self.assertTrue(health.json()["features"]["forge_tools"])
            response = client.post(f"{API_PREFIX}/forge-tools/validate", json={
                "tool": "search_resources",
                "arguments": {"model_path": "C:/private/model.gguf"},
            })
        self.assertEqual(422, response.status_code)
        self.assertEqual("validation_error", response.json()["detail"]["error"]["code"])
        self.assertNotIn("C:/private", response.text)

    @acceptance("AGENT-TOOLS-001@1", "revalidation,freshness")
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
            teacher = client.post(f"{API_PREFIX}/forge-tools/validate", json={
                "tool": "ask_teacher",
                "arguments": {"question": "How can I improve this prompt?"},
            })

        self.assertEqual(200, accepted.status_code)
        self.assertEqual("hash-1", accepted.json()["arguments"]["base_hash"])
        self.assertEqual(422, rejected.status_code)
        self.assertEqual("validation_error", rejected.json()["detail"]["error"]["code"])
        self.assertEqual(422, teacher.status_code)
        self.assertIn("unknown Forge tool", teacher.text)


if __name__ == "__main__":
    unittest.main()
