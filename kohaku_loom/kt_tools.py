from __future__ import annotations

import asyncio
import json
from typing import Any

from kohakuterrarium.modules.tool.base import BaseTool, ExecutionMode, ToolResult

from .danbooru import (
    inspect_danbooru_tag,
    inspect_danbooru_tags,
    related_danbooru_tags,
    search_danbooru_tags,
)


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

    async def _execute(self, args: dict[str, Any], **_: Any) -> ToolResult:
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
