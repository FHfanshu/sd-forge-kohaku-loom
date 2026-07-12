from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lib_qwen3vl_prompt_tools.constants import ASSISTANT_TOOLS
from lib_qwen3vl_prompt_tools.danbooru import inspect_danbooru_tag, inspect_danbooru_tags, related_danbooru_tags, search_danbooru_tags
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

    def test_search_supports_fuzzy_terms_and_or_groups(self):
        items = [
            {"kind": "lora", "id": "xiuran", "name": "Xiuran Moqing", "alias": "Dragon-Boy", "path": "characters/xiuran_moqing", "metadata": {}},
            {"kind": "lora", "id": "forest", "name": "Forest Style", "alias": "Trees", "path": "styles/forest", "metadata": {}},
        ]
        with patch("lib_qwen3vl_prompt_tools.forge_resources._items", return_value=items):
            fuzzy = search_resources("lora", "dragon boy")
            typo = search_resources("lora", "xiurann")
            either = search_resources("lora", "xiurann | forest")
        self.assertEqual(["Xiuran Moqing"], [item["name"] for item in fuzzy["items"]])
        self.assertEqual(["Xiuran Moqing"], [item["name"] for item in typo["items"]])
        self.assertEqual(["Xiuran Moqing", "Forest Style"], [item["name"] for item in either["items"]])

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
        for name in ("read_style_template", "search_resources", "inspect_resource", "apply_resource", "initialize_prompt"):
            self.assertIn(name, tools)
        self.assertEqual(["active", "txt2img", "img2img"], tools["read_style_template"]["parameters"]["properties"]["target"]["enum"])
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

    def test_danbooru_tags_skill_loads_agent_reference(self):
        result = load_prompt_skill("danbooru-tags")
        self.assertTrue(result["ok"])
        self.assertEqual("Danbooru tags agent reference", result["title"])
        self.assertIn("Tag What Is Visible", result["guide"])
        self.assertIn("tag_group%3Aimage_composition", result["guide"])
        self.assertIn("Never fabricate a canonical tag name", result["guide"])


class DanbooruLookupTests(unittest.TestCase):
    def test_search_normalizes_query_and_category(self):
        payload = [{"id": 1, "name": "blue_hair", "category": 0, "post_count": 42, "is_deprecated": False}]
        autocomplete = [{"tag": payload[0]}]
        with patch("lib_qwen3vl_prompt_tools.danbooru._request_json", side_effect=[autocomplete, payload, payload]) as request:
            result = search_danbooru_tags("Blue Hair", "general", 5)
        self.assertEqual("blue hair", result["query"])
        self.assertEqual("blue_hair", result["canonical_query"])
        self.assertEqual("blue hair", result["items"][0]["name"])
        self.assertEqual("blue hair", result["items"][0]["prompt_tag"])
        self.assertEqual("blue_hair", result["items"][0]["canonical_name"])
        self.assertEqual("general", result["items"][0]["category"])
        calls = [call.args[1] for call in request.call_args_list]
        tag_calls = [call for call in calls if "search[name_matches]" in call]
        self.assertIn("blue_hair*", [call["search[name_matches]"] for call in tag_calls])
        self.assertEqual(0, tag_calls[0]["search[category]"])

    def test_search_batches_queries_and_keeps_candidate_provenance(self):
        blue = {"id": 1, "name": "blue_hair", "category": 0, "post_count": 42, "is_deprecated": False}
        long = {"id": 2, "name": "long_hair", "category": 0, "post_count": 12, "is_deprecated": False}
        with patch("lib_qwen3vl_prompt_tools.danbooru._request_json", side_effect=[[{"tag": blue}], [blue], [blue], [{"tag": long}], [long], [long]]):
            result = search_danbooru_tags(queries=["blue hair", "long hair"], limit=5)
        self.assertEqual(["blue hair", "long hair"], [item["query"] for item in result["results"]])
        self.assertEqual("exact", result["results"][0]["items"][0]["match"])

    def test_batch_inspection_and_related_tags_are_bounded(self):
        tag_payload = [{"id": 1, "name": "blue_hair", "category": 0, "post_count": 42, "is_deprecated": False}]
        related_payload = {"related_tags": [{"tag": {"id": 2, "name": "long_hair", "category": 0, "post_count": 12, "is_deprecated": False}, "frequency": 0.5}], "wiki_page_tags": []}
        with patch("lib_qwen3vl_prompt_tools.danbooru._request_json", return_value=tag_payload):
            inspected = inspect_danbooru_tags(["blue hair", "blue_hair"])
        with patch("lib_qwen3vl_prompt_tools.danbooru._request_json", return_value=related_payload):
            related = related_danbooru_tags("blue hair", limit=1)
        self.assertEqual(1, len(inspected["items"]))
        self.assertIsNone(inspected["items"][0].get("wiki"))
        self.assertEqual("long hair", related["related"][0]["name"])

    def test_inspect_returns_only_exact_tag_and_wiki(self):
        tag_payload = [
            {"id": 2, "name": "blue_hair", "category": 0, "post_count": 42, "is_deprecated": False},
            {"id": 3, "name": "blue_hairband", "category": 0, "post_count": 1, "is_deprecated": False},
        ]
        wiki_payload = [{"title": "blue_hair", "body": "Blue hair definition", "updated_at": "2026-07-12"}]
        with patch("lib_qwen3vl_prompt_tools.danbooru._request_json", side_effect=[tag_payload, wiki_payload]):
            result = inspect_danbooru_tag("blue hair")
        self.assertTrue(result["ok"])
        self.assertEqual("blue hair", result["name"])
        self.assertEqual("blue_hair", result["canonical_name"])
        self.assertEqual("Blue hair definition", result["wiki"]["body"])


if __name__ == "__main__":
    unittest.main()
