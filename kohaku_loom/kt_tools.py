from __future__ import annotations

import asyncio
import json
from typing import Any, Callable, Mapping

from kohakuterrarium.modules.tool.base import BaseTool, ExecutionMode, ToolResult

from .danbooru import (
    inspect_danbooru_tag,
    inspect_danbooru_tags,
    related_danbooru_tags,
    search_danbooru_tags,
)
from .prompt_skills import load_prompt_skill
from .tool_args import unwrap_object_content


def _compat_danbooru_arguments(args: dict[str, Any]) -> dict[str, Any]:
    normalized = unwrap_object_content(args)
    if normalized.get("action"):
        return normalized

    content = str(normalized.get("content") or "").strip()
    if not content:
        return normalized
    command, _, query = content.partition(" ")
    command = command.lower()
    query = query.strip()
    if command in {"search", "find", "lookup"} and query:
        normalized.update({"action": "search", "query": query})
    elif command == "inspect" and query and "," not in query:
        normalized.update({"action": "inspect", "name": query})
    elif command == "related" and query:
        normalized.update({"action": "related", "name": query})
    else:
        normalized.update({"action": "search", "query": query or content})
    return normalized


class DanbooruTool(BaseTool):
    @property
    def tool_name(self) -> str:
        return "danbooru"

    @property
    def description(self) -> str:
        return "Search, inspect, batch-inspect, or find related canonical Danbooru tags."

    @property
    def execution_mode(self) -> ExecutionMode:
        return ExecutionMode.DIRECT

    parameters = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["search", "inspect", "inspect_batch", "related"],
            },
            "query": {"type": "string"},
            "queries": {"type": "array", "items": {"type": "string"}},
            "name": {"type": "string"},
            "names": {"type": "array", "items": {"type": "string"}},
            "category": {"type": "string"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 25},
            "include_wiki": {"type": "boolean"},
        },
        "required": ["action"],
    }

    def get_parameters_schema(self) -> dict[str, Any]:
        return dict(self.parameters)

    async def _execute(self, args: dict[str, Any], **_: Any) -> ToolResult:
        args = _compat_danbooru_arguments(args)
        action = str(args.get("action") or "").strip()
        try:
            if action == "search":
                value = await asyncio.to_thread(
                    search_danbooru_tags,
                    str(args.get("query") or ""),
                    str(args.get("category") or ""),
                    int(args.get("limit") or 12),
                    args.get("queries"),
                )
            elif action == "inspect":
                value = await asyncio.to_thread(
                    inspect_danbooru_tag,
                    str(args.get("name") or ""),
                    bool(args.get("include_wiki", True)),
                )
            elif action == "inspect_batch":
                value = await asyncio.to_thread(
                    inspect_danbooru_tags,
                    args.get("names"),
                    bool(args.get("include_wiki", False)),
                )
            elif action == "related":
                value = await asyncio.to_thread(
                    related_danbooru_tags,
                    str(args.get("name") or ""),
                    str(args.get("category") or ""),
                    int(args.get("limit") or 12),
                )
            else:
                return ToolResult(output="Unsupported Danbooru action.", error="unsupported_action")
            return ToolResult(output=json.dumps(value, ensure_ascii=False))
        except Exception as error:
            return ToolResult(output=str(error), error=type(error).__name__)


class PromptSkillTool(BaseTool):
    @property
    def tool_name(self) -> str:
        return "load_prompt_skill"

    @property
    def description(self) -> str:
        return "Load a named prompt-engineering skill reference for the current task."

    @property
    def execution_mode(self) -> ExecutionMode:
        return ExecutionMode.DIRECT

    parameters = {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
        },
        "required": ["name"],
    }

    def get_parameters_schema(self) -> dict[str, Any]:
        return dict(self.parameters)

    async def _execute(self, args: dict[str, Any], **_: Any) -> ToolResult:
        try:
            value = await asyncio.to_thread(load_prompt_skill, str(args.get("name") or ""))
            output = json.dumps(value, ensure_ascii=False)
            if isinstance(value, dict) and value.get("ok") is False:
                return ToolResult(output=output, error=str(value.get("error") or "prompt_skill_unavailable"))
            return ToolResult(output=output)
        except Exception as error:
            return ToolResult(output=str(error), error=type(error).__name__)


class LoadToolGroupTool(BaseTool):
    """Expose the fixed session-local native tool disclosure catalog."""

    needs_context = True

    def __init__(
        self,
        load_group: Callable[[Any, str], dict[str, Any]],
        groups: Mapping[str, Any],
    ):
        super().__init__()
        self._load_group = load_group
        self._groups = tuple(sorted(str(group) for group in groups))
        self.parameters = {
            "type": "object",
            "properties": {
                "group": {
                    "type": "string",
                    "enum": list(self._groups),
                    "description": "Fixed optional Loom capability group to disclose.",
                },
            },
            "required": ["group"],
            "additionalProperties": False,
        }

    @property
    def tool_name(self) -> str:
        return "load_tool_group"

    @property
    def description(self) -> str:
        return "Load one fixed optional Loom tool group for this session."

    @property
    def execution_mode(self) -> ExecutionMode:
        return ExecutionMode.DIRECT

    def get_parameters_schema(self) -> dict[str, Any]:
        return dict(self.parameters)

    async def _execute(self, args: dict[str, Any], context: Any = None, **_: Any) -> ToolResult:
        normalized = unwrap_object_content(args)
        group = str(normalized.get("group") or "").strip().lower()
        if group not in self._groups:
            return ToolResult(
                output=json.dumps(
                    {
                        "ok": False,
                        "error": "unknown_tool_group",
                        "group": group,
                        "available_groups": list(self._groups),
                    },
                    ensure_ascii=False,
                ),
                error="unknown_tool_group",
            )
        agent = getattr(context, "agent", None)
        if agent is None:
            return ToolResult(output='{"ok":false,"error":"agent_context_unavailable"}', error="agent_context_unavailable")
        try:
            result = self._load_group(agent, group)
        except Exception as error:
            return ToolResult(output=str(error), error="tool_group_load_failed")
        output = json.dumps(result, ensure_ascii=False)
        if result.get("ok") is False:
            return ToolResult(output=output, error=str(result.get("error") or "tool_group_unavailable"))
        return ToolResult(output=output)
