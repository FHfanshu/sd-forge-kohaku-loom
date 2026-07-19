from __future__ import annotations

from typing import Any

from kohaku_loom.forge_bridge import ForgeToolBroker
from kohaku_loom.forge_tools import tool_group_catalog, tool_group_tools
from kohaku_loom.kt_tools import LoadToolGroupTool


def build_bootstrap_tool(
    broker: ForgeToolBroker,
    *,
    forge_bridge: bool,
    timeout: float = 300.0,
) -> LoadToolGroupTool:
    catalog = tool_group_catalog(forge_bridge=forge_bridge)

    def load_group(agent: Any, group: str) -> dict[str, Any]:
        return load_tool_group(
            agent,
            group,
            broker=broker,
            timeout=timeout,
            forge_bridge=forge_bridge,
        )

    return LoadToolGroupTool(load_group, catalog)


def initial_tools(
    broker: ForgeToolBroker,
    *,
    forge_bridge: bool,
    timeout: float = 300.0,
) -> list[Any]:
    tools: list[Any] = [build_bootstrap_tool(broker, forge_bridge=forge_bridge, timeout=timeout)]
    if forge_bridge:
        from kohaku_loom.forge_tools import EditPromptTool, ReadPromptTool

        tools.extend([ReadPromptTool(broker, timeout), EditPromptTool(broker, timeout)])
    return tools


def load_tool_group(
    agent: Any,
    group: str,
    *,
    broker: ForgeToolBroker,
    timeout: float = 300.0,
    forge_bridge: bool = True,
) -> dict[str, Any]:
    """Add one fixed group to an agent without persisting disclosure state."""
    group = str(group or "").strip().lower()
    catalog = tool_group_catalog(forge_bridge=forge_bridge)
    if group not in catalog:
        return {
            "ok": False,
            "error": "unknown_tool_group",
            "group": group,
            "available_groups": sorted(catalog),
        }

    tools = tool_group_tools(
        group,
        broker,
        timeout,
        forge_bridge=forge_bridge,
    )
    loaded: list[str] = []
    already_loaded: list[str] = []
    used_agent_add_tool = False
    for tool in tools:
        name = str(tool.tool_name)
        if _agent_has_tool(agent, name):
            already_loaded.append(name)
            continue
        used_agent_add_tool = _add_tool(agent, tool) or used_agent_add_tool
        loaded.append(name)

    if loaded and not used_agent_add_tool:
        refresh = getattr(agent, "refresh_system_prompt", None)
        if callable(refresh):
            refresh()
    return {
        "ok": True,
        "group": group,
        "loaded": loaded,
        "already_loaded": already_loaded,
        "tools": [str(tool) for tool in catalog[group]],
    }


def _agent_has_tool(agent: Any, name: str) -> bool:
    registry = getattr(agent, "registry", None)
    get_tool = getattr(registry, "get_tool", None)
    if callable(get_tool):
        try:
            found = get_tool(name)
            if found is not None and str(getattr(found, "tool_name", "")) == name:
                return True
        except Exception:
            pass
    list_tools = getattr(registry, "list_tools", None)
    if callable(list_tools):
        try:
            names = list_tools()
            if isinstance(names, (list, tuple, set, frozenset)) and name in names:
                return True
        except Exception:
            pass
    registry_tools = getattr(registry, "_tools", None)
    if isinstance(registry_tools, dict) and name in registry_tools:
        return True
    executor = getattr(agent, "executor", None)
    get_executor_tool = getattr(executor, "get_tool", None)
    if callable(get_executor_tool):
        try:
            found = get_executor_tool(name)
            return found is not None and str(getattr(found, "tool_name", "")) == name
        except Exception:
            pass
    executor_tools = getattr(executor, "_tools", None)
    if isinstance(executor_tools, dict) and name in executor_tools:
        return True
    tools = getattr(agent, "tools", None)
    if isinstance(tools, (list, tuple, set, frozenset)):
        return name in tools
    if isinstance(tools, dict):
        return name in tools
    return False


def _add_tool(agent: Any, tool: Any) -> bool:
    add_tool = getattr(agent, "add_tool", None)
    if callable(add_tool):
        add_tool(tool)
        return True

    registry = getattr(agent, "registry", None)
    register = getattr(registry, "register_tool", None)
    if not callable(register):
        raise RuntimeError("KohakuTerrarium agent cannot add tools")
    register(tool)
    executor = getattr(agent, "executor", None)
    register_executor = getattr(executor, "register_tool", None)
    if callable(register_executor):
        register_executor(tool)
    return False
