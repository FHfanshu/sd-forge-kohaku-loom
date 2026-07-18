from __future__ import annotations

import asyncio
import json
from typing import Any, Callable

from kohakuterrarium.modules.tool.base import BaseTool, ExecutionMode, ToolResult

from .forge_bridge import ForgeToolBroker
from .kt_tools import DanbooruTool, PromptSkillTool
from .tool_args import unwrap_object_content


class ForgeBridgeTool(BaseTool):
    is_concurrency_safe = False

    def __init__(
        self,
        broker: ForgeToolBroker,
        timeout: float = 300.0,
        mode_provider: Callable[[], str] | None = None,
    ):
        super().__init__()
        self.broker = broker
        self.timeout = timeout
        self.mode_provider = mode_provider or (lambda: "normal")

    @property
    def execution_mode(self) -> ExecutionMode:
        return ExecutionMode.DIRECT

    async def _execute(self, args: dict[str, Any], **_: Any) -> ToolResult:
        try:
            request_args = unwrap_object_content(args)
            request_args.pop("_yolo_authorized", None)
            if self.mode_provider() == "yolo":
                request_args["_yolo_authorized"] = True
            result = await self.broker.request(
                self.tool_name,
                request_args,
                self.timeout,
            )
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


class YoloForgeBridgeTool(ForgeBridgeTool):
    def __init__(
        self,
        broker: ForgeToolBroker,
        timeout: float = 300.0,
        mode_provider: Callable[[], str] | None = None,
    ):
        super().__init__(broker, timeout, mode_provider)

    async def _execute(self, args: dict[str, Any], **kwargs: Any) -> ToolResult:
        if self.mode_provider() != "yolo":
            return ToolResult(
                output='{"ok":false,"error":"YOLO mode is required"}',
                error="yolo_mode_required",
            )
        authorized_args = dict(args)
        authorized_args["_yolo_authorized"] = True
        return await super()._execute(authorized_args, **kwargs)


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


class ReadTxt2ImgStateTool(YoloForgeBridgeTool):
    @property
    def tool_name(self) -> str:
        return "read_txt2img_state"

    @property
    def description(self) -> str:
        return "Read the guarded Forge txt2img prompt and core generation parameters. YOLO mode only."

    parameters = {"type": "object", "properties": {}}


class ApplyTxt2ImgPatchTool(YoloForgeBridgeTool):
    @property
    def tool_name(self) -> str:
        return "apply_txt2img_patch"

    @property
    def description(self) -> str:
        return (
            "Atomically apply a hash-guarded patch to approved Forge txt2img parameters. "
            "Use prompt patch operations instead of replacing whole prompts. YOLO mode only."
        )

    parameters = {
        "type": "object",
        "properties": {
            "state_hash": {"type": "string"},
            "changes": {
                "type": "object",
                "properties": {
                    "positive_prompt_patches": {"type": "array", "items": {"type": "object"}},
                    "negative_prompt_patches": {"type": "array", "items": {"type": "object"}},
                    "seed": {"type": "integer", "minimum": -1, "maximum": 4294967295},
                    "width": {"type": "integer", "minimum": 64, "maximum": 4096},
                    "height": {"type": "integer", "minimum": 64, "maximum": 4096},
                    "steps": {"type": "integer", "minimum": 1, "maximum": 150},
                    "cfg_scale": {"type": "number", "minimum": 0, "maximum": 30},
                    "sampler": {"type": "string"},
                    "scheduler": {"type": "string"},
                },
                "additionalProperties": False,
            },
        },
        "required": ["state_hash", "changes"],
    }


def forge_tools(
    broker: ForgeToolBroker,
    timeout: float = 300.0,
    mode_provider: Callable[[], str] | None = None,
) -> list[BaseTool]:
    return [
        AskTeacherTool(broker, timeout, mode_provider),
        ReadPromptTool(broker, timeout, mode_provider),
        ReadStyleTemplateTool(broker, timeout, mode_provider),
        EditPromptTool(broker, timeout, mode_provider),
        InitializePromptTool(broker, timeout, mode_provider),
        ResourceTool(broker, timeout, mode_provider),
        DanbooruTool(),
        PromptSkillTool(),
    ]


def yolo_forge_tools(
    broker: ForgeToolBroker,
    timeout: float = 300.0,
    mode_provider: Callable[[], str] | None = None,
) -> list[BaseTool]:
    return [
        ReadTxt2ImgStateTool(broker, timeout, mode_provider),
        ApplyTxt2ImgPatchTool(broker, timeout, mode_provider),
    ]
