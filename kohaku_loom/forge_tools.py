from __future__ import annotations

import asyncio
import json
from typing import Any

from kohakuterrarium.modules.tool.base import BaseTool, ExecutionMode, ToolResult

from .forge_bridge import ForgeToolBroker


class ForgeBridgeTool(BaseTool):
    is_concurrency_safe = False

    def __init__(self, broker: ForgeToolBroker, timeout: float = 300.0):
        super().__init__()
        self.broker = broker
        self.timeout = timeout

    @property
    def execution_mode(self) -> ExecutionMode:
        return ExecutionMode.DIRECT

    async def _execute(self, args: dict[str, Any], **_: Any) -> ToolResult:
        try:
            result = await self.broker.request(self.tool_name, args, self.timeout)
        except TimeoutError as error:
            return ToolResult(output=str(error), error="forge_tool_timeout")
        except asyncio.CancelledError:
            raise
        serialized = json.dumps(result, ensure_ascii=False)
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
        return "Read the current Forge prompt and guarded context hashes."

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
        return "Apply a guarded preview-first patch to a Forge prompt."

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


def forge_tools(broker: ForgeToolBroker, timeout: float = 300.0) -> list[BaseTool]:
    return [
        AskTeacherTool(broker, timeout),
        ReadPromptTool(broker, timeout),
        ReadStyleTemplateTool(broker, timeout),
        EditPromptTool(broker, timeout),
        InitializePromptTool(broker, timeout),
        ResourceTool(broker, timeout),
    ]
