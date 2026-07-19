from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock


try:
    from kohakuterrarium.core.agent import Agent
    from kohakuterrarium.llm.tools import build_tool_schemas
    from kohakuterrarium.testing.llm import ScriptEntry, ScriptedLLM

    from kohaku_loom.forge_bridge import ForgeToolBroker
    from kohaku_loom.forge_tools import tool_group_catalog
    from kohaku_loom.sidecar.tool_disclosure import (
        build_bootstrap_tool,
        initial_tools,
        load_tool_group,
    )

    KT_AVAILABLE = True
except (ImportError, ModuleNotFoundError):
    KT_AVAILABLE = False


@unittest.skipUnless(KT_AVAILABLE, "KohakuTerrarium sidecar dependency is not installed")
class LoomToolDisclosureTests(unittest.IsolatedAsyncioTestCase):
    async def _build_agent(self, bootstrap):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "config.yaml").write_text(
                """name: disclosure
version: "1.0"
controller:
  tool_format: native
system_prompt: "Use only the tools currently available."
skill_mode: dynamic
input:
  type: none
output:
  type: stdout
""",
                encoding="utf-8",
            )
            agent = await Agent.build(
                path,
                llm=ScriptedLLM([ScriptEntry("ok")]),
                io="headless",
                strict=True,
                tools=bootstrap if isinstance(bootstrap, list) else [bootstrap],
            )
            yield agent

    async def test_catalog_and_initial_native_tool_set_are_minimal(self):
        catalog = tool_group_catalog()
        self.assertEqual(
            {
                "forge_resource",
                "danbooru",
                "teacher",
                "prompt_knowledge",
            },
            set(catalog),
        )
        self.assertEqual(
            ("read_style_template", "forge_resource"),
            catalog["forge_resource"],
        )

        bootstrap = initial_tools(ForgeToolBroker(), forge_bridge=True)
        async for agent in self._build_agent(bootstrap):
            names = set(agent.registry.list_tools())
            schemas = {schema.name for schema in build_tool_schemas(agent.registry)}
            initial_prompt = agent.get_system_prompt()

        self.assertIn("load_tool_group", names)
        self.assertIn("read_prompt", names)
        self.assertNotIn("danbooru", names)
        self.assertIn("load_tool_group", schemas)
        self.assertIn("read_prompt", schemas)
        self.assertNotIn("danbooru", schemas)
        self.assertNotIn("danbooru", initial_prompt)

    async def test_loading_is_idempotent_and_refreshes_after_registry_change(self):
        broker = ForgeToolBroker()
        bootstrap = build_bootstrap_tool(broker, forge_bridge=True)
        async for agent in self._build_agent(bootstrap):
            with mock.patch.object(
                agent,
                "refresh_system_prompt",
                wraps=agent.refresh_system_prompt,
            ) as refresh:
                first = load_tool_group(agent, "danbooru", broker=broker)
                second = load_tool_group(agent, "danbooru", broker=broker)
                names = agent.registry.list_tools()
                schemas = {schema.name for schema in build_tool_schemas(agent.registry)}
                prompt = agent.get_system_prompt()

        self.assertEqual(["danbooru"], first["loaded"])
        self.assertEqual(["danbooru"], second["already_loaded"])
        self.assertEqual([], second["loaded"])
        self.assertEqual(1, names.count("danbooru"))
        self.assertIn("danbooru", schemas)
        self.assertIn("danbooru", prompt)
        self.assertEqual(1, refresh.call_count)

    async def test_unknown_group_fails_closed_without_registry_change(self):
        broker = ForgeToolBroker()
        bootstrap = build_bootstrap_tool(broker, forge_bridge=True)
        async for agent in self._build_agent(bootstrap):
            before = list(agent.registry.list_tools())
            result = load_tool_group(agent, "not-a-real-group", broker=broker)
            native_result = await bootstrap._execute(
                {"group": "not-a-real-group"},
                context=mock.Mock(agent=agent),
            )
            after = list(agent.registry.list_tools())

        self.assertFalse(result["ok"])
        self.assertEqual("unknown_tool_group", result["error"])
        self.assertEqual(before, after)
        self.assertEqual("unknown_tool_group", native_result.error)

    async def test_forge_bridge_false_hides_forge_groups(self):
        broker = ForgeToolBroker()
        catalog = tool_group_catalog(forge_bridge=False)
        self.assertEqual({"danbooru", "prompt_knowledge"}, set(catalog))

        bootstrap = build_bootstrap_tool(broker, forge_bridge=False)
        self.assertEqual(
            ["danbooru", "prompt_knowledge"],
            bootstrap.parameters["properties"]["group"]["enum"],
        )
        async for agent in self._build_agent(bootstrap):
            results = {
                group: load_tool_group(
                    agent,
                    group,
                    broker=broker,
                    forge_bridge=False,
                )
                for group in ("forge_resource", "teacher")
            }

        self.assertTrue(all(not result["ok"] for result in results.values()))
        self.assertTrue(all(result["error"] == "unknown_tool_group" for result in results.values()))
        self.assertNotIn("read_prompt", agent.registry.list_tools())
        self.assertNotIn("read_style_template", agent.registry.list_tools())
        self.assertNotIn("ask_teacher", agent.registry.list_tools())
        self.assertNotIn("edit_prompt", agent.registry.list_tools())

    async def test_initial_prompt_tools_stay_visible_while_optional_groups_load(self):
        broker = ForgeToolBroker()
        bootstrap = initial_tools(broker, forge_bridge=True)
        async for agent in self._build_agent(bootstrap):
            provider_tool = mock.Mock(tool_name="provider_native")
            provider_tool.description = "Provider-native test tool"
            provider_tool.get_parameters_schema.return_value = {"type": "object", "properties": {}}
            agent.add_tool(provider_tool)
            load_tool_group(agent, "forge_resource", broker=broker)
            load_tool_group(agent, "teacher", broker=broker)
            load_tool_group(agent, "danbooru", broker=broker)

            names = set(agent.registry.list_tools())
            schemas = {schema.name for schema in build_tool_schemas(agent.registry)}

        self.assertIn("read_prompt", names)
        self.assertIn("edit_prompt", names)
        self.assertIn("read_prompt", schemas)
        self.assertIn("edit_prompt", schemas)


if __name__ == "__main__":
    unittest.main()
