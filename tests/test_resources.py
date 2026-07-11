from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lib_qwen3vl_prompt_tools.constants import ASSISTANT_TOOLS
from lib_qwen3vl_prompt_tools.forge_resources import inspect_resource, search_resources
from lib_qwen3vl_prompt_tools.prompt_skills import automatic_prompt_skill, load_prompt_skill


class ResourceCatalogTests(unittest.TestCase):
    def test_search_uses_case_insensitive_and_terms_with_cursor(self):
        items = [
            {"kind": "lora", "id": "hero-a", "name": "Hero A", "alias": "Blue Knight", "path": "characters/hero-a", "metadata": {}},
            {"kind": "lora", "id": "hero-b", "name": "Hero B", "alias": "Red Knight", "path": "characters/hero-b", "metadata": {}},
            {"kind": "lora", "id": "scene", "name": "Forest", "alias": "Trees", "path": "styles/forest", "metadata": {}},
        ]
        with patch("lib_qwen3vl_prompt_tools.forge_resources._items", return_value=items):
            first = search_resources("lora", "HERO knight", limit=1)
            second = search_resources("lora", "HERO knight", limit=1, cursor=first["next_cursor"])
        self.assertEqual("Hero A", first["items"][0]["name"])
        self.assertEqual("Hero B", second["items"][0]["name"])
        self.assertEqual(2, first["total"])
        self.assertFalse(second["next_cursor"])

    def test_wildcard_nested_names_are_logical_and_paginated(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "people" / "artists.txt"
            path.parent.mkdir()
            path.write_text("Alice\nBob\nBlue Artist\n", encoding="utf-8")
            with patch("lib_qwen3vl_prompt_tools.forge_resources._wildcard_root", return_value=root), patch(
                "lib_qwen3vl_prompt_tools.forge_resources._wildcard_manager", return_value=None
            ):
                found = search_resources("wildcard", "people", limit=20)
                inspected = inspect_resource("wildcard", "people/artists", query="b", limit=1)
        self.assertEqual("people/artists", found["items"][0]["id"])
        self.assertEqual("__people/artists__", found["items"][0]["token"])
        self.assertEqual(2, inspected["total"])
        self.assertEqual("Bob", inspected["items"][0]["value"])

    def test_wildcard_rejects_path_traversal(self):
        with self.assertRaisesRegex(ValueError, "invalid wildcard id"):
            inspect_resource("wildcard", "../secrets")

    def test_style_inspection_returns_full_templates(self):
        item = {"kind": "style", "id": "moqing", "name": "moqing", "prompt": "positive {prompt}", "negative_prompt": "bad"}
        with patch("lib_qwen3vl_prompt_tools.forge_resources._items", return_value=[item]):
            result = inspect_resource("style", "MOQING")
        self.assertEqual("positive {prompt}", result["prompt"])
        self.assertEqual("bad", result["negative_prompt"])

    def test_assistant_tool_contract_contains_resource_and_negative_prompt_tools(self):
        tools = {item["function"]["name"]: item["function"] for item in ASSISTANT_TOOLS}
        for name in ("search_resources", "inspect_resource", "apply_resource", "initialize_prompt"):
            self.assertIn(name, tools)
        self.assertNotIn("load_prompt_skill", tools)
        edit_fields = tools["edit_prompt"]["parameters"]["properties"]["field"]["enum"]
        self.assertEqual(["positive", "negative"], edit_fields)


class PromptSkillTests(unittest.TestCase):
    def test_anima_skill_loads_and_is_model_specific(self):
        result = load_prompt_skill("anima-dit")
        self.assertTrue(result["ok"])
        self.assertIn("@artist name", result["guide"])
        self.assertIn("Qwen3 0.6B text encoder", result["guide"])
        self.assertIn("256 tokens is an absolute ceiling, not a target", result["guide"])
        self.assertIn("negative prompt has no effect", result["guide"])
        self.assertIn("CFG must be above 1", result["guide"])
        self.assertEqual("anima_dit", automatic_prompt_skill("anima", "anything"))
        self.assertEqual("anima_dit", automatic_prompt_skill("all", "Anima-Aesthetic-v1"))
        self.assertEqual("", automatic_prompt_skill("sdxl", "other-model"))


if __name__ == "__main__":
    unittest.main()
