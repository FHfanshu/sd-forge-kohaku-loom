from __future__ import annotations

import asyncio
import json
from typing import Any

from kohakuterrarium.modules.tool.base import BaseTool, ExecutionMode, ToolResult

from .forge_bridge import ForgeToolBroker
from .kt_tools import DanbooruTool, PromptSkillTool
from .tool_args import unwrap_object_content


TOOL_GROUP_CATALOG: dict[str, tuple[str, ...]] = {
    "forge_resource": ("read_style_template", "forge_resource"),
    "danbooru": ("danbooru",),
    "teacher": ("ask_teacher",),
    "prompt_knowledge": ("load_prompt_skill",),
}
_FORGE_TOOL_GROUPS = frozenset({"forge_resource", "teacher"})


def tool_group_catalog(*, forge_bridge: bool = True) -> dict[str, tuple[str, ...]]:
    """Return the fixed native disclosure catalog for one Loom session."""
    return {
        group: tools
        for group, tools in TOOL_GROUP_CATALOG.items()
        if forge_bridge or group not in _FORGE_TOOL_GROUPS
    }


def compact_forge_tool_result(tool_name: str, result: dict[str, Any]) -> dict[str, Any]:
    """Return the smallest model-facing result that preserves the tool contract."""
    if tool_name != "read_prompt" or result.get("ok") is False:
        return result
    prompt = result.get("prompt", result.get("positive_prompt", ""))
    prompt_hash = result.get("prompt_hash", result.get("positive_prompt_hash", ""))
    compact = {
        "ok": result.get("ok", True),
        "target": result.get("target", "active"),
        "prompt": prompt,
        "prompt_hash": prompt_hash,
        "negative_prompt": result.get("negative_prompt", ""),
        "negative_prompt_hash": result.get("negative_prompt_hash", ""),
        "context_hash": result.get("context_hash", ""),
        "forge_preset": result.get("forge_preset", ""),
        "checkpoint": result.get("checkpoint", ""),
        "style_template": result.get("style_template", ""),
    }
    return compact


class ForgeBridgeTool(BaseTool):
    is_concurrency_safe = False

    def __init__(
        self,
        broker: ForgeToolBroker,
        timeout: float = 300.0,
    ):
        super().__init__()
        self.broker = broker
        self.timeout = timeout

    def get_parameters_schema(self) -> dict[str, Any]:
        """Expose the declared native schema to KT versions that query it."""
        return dict(getattr(self, "parameters", {}) or {})

    @property
    def execution_mode(self) -> ExecutionMode:
        return ExecutionMode.DIRECT

    async def _execute(self, args: dict[str, Any], **_: Any) -> ToolResult:
        try:
            request_args = unwrap_object_content(args)
            result = await self.broker.request(
                self.tool_name,
                request_args,
                self.timeout,
            )
        except TimeoutError as error:
            return ToolResult(output=str(error), error="forge_tool_timeout")
        except asyncio.CancelledError:
            raise
        serialized = json.dumps(compact_forge_tool_result(self.tool_name, result), ensure_ascii=False)
        if result.get("ok") is False:
            return ToolResult(
                output=serialized,
                error=str(result.get("error") or f"Forge tool {self.tool_name!r} failed"),
            )
        return ToolResult(output=serialized)


class ReadPromptTool(ForgeBridgeTool):
    @property
    def tool_name(self) -> str:
        return "read_prompt"

    @property
    def description(self) -> str:
        return "Read the current Forge prompt. Use its returned hash as edit_prompt.base_hash."

    parameters = {
        "type": "object",
        "properties": {"target": {"type": "string", "enum": ["active", "txt2img", "img2img"]}},
    }


class ReadStyleTemplateTool(ForgeBridgeTool):
    @property
    def tool_name(self) -> str:
        return "read_style_template"

    @property
    def description(self) -> str:
        return "Read the active Forge Style selections and resolved prompt templates."

    parameters = {
        "type": "object",
        "properties": {"target": {"type": "string", "enum": ["active", "txt2img", "img2img"]}},
    }


class AskTeacherTool(ForgeBridgeTool):
    @property
    def tool_name(self) -> str:
        return "ask_teacher"

    @property
    def description(self) -> str:
        return "Ask the configured teacher model for a sanitized second opinion."

    parameters = {
        "type": "object",
        "properties": {
            "question": {"type": "string"},
            "context": {"type": "string"},
            "goal": {"type": "string"},
        },
        "required": ["question"],
    }


class EditPromptTool(ForgeBridgeTool):
    @property
    def tool_name(self) -> str:
        return "edit_prompt"

    @property
    def description(self) -> str:
        return "Edit the current Forge prompt after read_prompt. The guarded edit applies immediately and can be undone from the Forge UI."

    parameters = {
        "type": "object",
        "properties": {
            "target": {"type": "string", "enum": ["active", "txt2img", "img2img"]},
            "field": {"type": "string", "enum": ["positive", "negative"]},
            "base_hash": {"type": "string"},
            "prompt": {"type": "string"},
            "diff": {"type": "string"},
            "patches": {"type": "array", "items": {"type": "object"}},
            "return_prompt": {"type": "boolean"},
        },
        "required": ["base_hash"],
    }


class InitializePromptTool(ForgeBridgeTool):
    @property
    def tool_name(self) -> str:
        return "initialize_prompt"

    @property
    def description(self) -> str:
        return "Fill only empty Forge prompt fields after an explicit request."

    parameters = {
        "type": "object",
        "properties": {
            "target": {"type": "string", "enum": ["active", "txt2img", "img2img"]},
            "positive": {"type": "string"},
            "negative": {"type": "string"},
            "context_hash": {"type": "string"},
        },
        "required": ["context_hash"],
    }


class ResourceTool(ForgeBridgeTool):
    @property
    def tool_name(self) -> str:
        return "forge_resource"

    @property
    def description(self) -> str:
        return "Search, inspect, or apply Forge Wildcards, Styles, and LoRAs."

    parameters = {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["search", "inspect", "apply"]},
            "kind": {"type": "string", "enum": ["wildcard", "style", "lora"]},
            "query": {"type": "string"},
            "resource_id": {"type": "string"},
            "target": {"type": "string", "enum": ["active", "txt2img", "img2img"]},
            "context_hash": {"type": "string"},
            "weight": {"type": "number"},
            "limit": {"type": "integer"},
            "cursor": {"type": "string"},
        },
        "required": ["action"],
    }


def tool_group_tools(
    group: str,
    broker: ForgeToolBroker,
    timeout: float = 300.0,
    *,
    forge_bridge: bool = True,
) -> list[BaseTool]:
    """Build tools for one fixed disclosure group."""
    if group not in TOOL_GROUP_CATALOG:
        raise ValueError(f"unknown tool group: {group}")
    if not forge_bridge and group in _FORGE_TOOL_GROUPS:
        raise ValueError(f"tool group is unavailable without the Forge bridge: {group}")
    if group == "forge_resource":
        return [
            ReadStyleTemplateTool(broker, timeout),
            ResourceTool(broker, timeout),
        ]
    if group == "danbooru":
        return [DanbooruTool()]
    if group == "teacher":
        return [AskTeacherTool(broker, timeout)]
    return [PromptSkillTool()]


def forge_tools(
    broker: ForgeToolBroker,
    timeout: float = 300.0,
) -> list[BaseTool]:
    resources = tool_group_tools("forge_resource", broker, timeout)
    return [
        AskTeacherTool(broker, timeout),
        ReadPromptTool(broker, timeout),
        resources[0],
        EditPromptTool(broker, timeout),
        InitializePromptTool(broker, timeout),
        resources[1],
        DanbooruTool(),
        PromptSkillTool(),
    ]
