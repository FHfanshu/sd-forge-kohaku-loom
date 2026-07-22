from __future__ import annotations

import re
from typing import Any


FORGE_TOOL_NAMES = (
    "read_prompt",
    "edit_prompt",
    "read_generation_parameters",
    "apply_generation_parameters",
    "search_resources",
    "inspect_resource",
    "search_danbooru_tags",
    "inspect_danbooru_tags",
    "related_danbooru_tags",
)
_FORBIDDEN_KEYS = frozenset({
    "api_key",
    "apikey",
    "endpoint",
    "headers",
    "model",
    "model_id",
    "model_path",
    "modelpath",
    "mmproj_path",
    "draft_model_path",
    "mmprojpath",
    "llama_server_path",
    "llamaserverpath",
})
_LOCAL_PATH_RE = re.compile(r"(?:^[A-Za-z]:[\\/]|^\\\\|^/|^\.?\.?[\\/]|\.gguf$|\.safetensors$)", re.IGNORECASE)
_PATCH_OPERATIONS = frozenset({
    "append",
    "prepend",
    "replace",
    "replace_all",
    "replace_n",
    "delete",
    "insert_after",
    "insert_before",
})
_PATCH_KEYS = frozenset({
    "operation",
    "find",
    "replace",
    "text",
    "replacement",
    "separator",
    "count",
    "allow_multiple",
})


class ForgeToolValidationError(ValueError):
    """A browser-owned Forge tool request failed the server boundary."""


def validate_forge_tool_request(tool: str, payload: Any) -> dict[str, Any]:
    """Validate server-owned tool arguments without accepting provider controls."""
    if tool not in FORGE_TOOL_NAMES:
        raise ForgeToolValidationError("unknown Forge tool")
    if not isinstance(payload, dict):
        raise ForgeToolValidationError("Forge tool arguments must be an object")
    _reject_server_owned_fields(payload)
    if tool == "search_resources":
        _allow_keys(payload, {"kind", "query", "limit", "cursor"})
        _validate_resource_arguments(payload, require_id=False)
    elif tool == "inspect_resource":
        _allow_keys(payload, {"kind", "id", "query", "limit", "cursor"})
        _validate_resource_arguments(payload, require_id=True)
    elif tool == "read_prompt":
        _allow_keys(payload, {"target", "field"})
        _validate_target(payload)
        _validate_prompt_field(payload)
    elif tool == "read_generation_parameters":
        _allow_keys(payload, {"target"})
        _validate_target(payload)
    elif tool == "edit_prompt":
        _allow_keys(payload, {"target", "base_hash", "negative_state_hash", "prompt", "diff", "patches", "return_prompt", "field"})
        _validate_target(payload)
        _validate_prompt_field(payload)
        _safe_text(payload.get("base_hash"), "base_hash", 128, required=True)
        _safe_text(payload.get("negative_state_hash"), "negative_state_hash", 128)
        _safe_text(payload.get("prompt"), "prompt", 50_000)
        _safe_text(payload.get("diff"), "diff", 50_000)
        patches = payload.get("patches")
        if patches is not None and (not isinstance(patches, list) or len(patches) > 32):
            raise ForgeToolValidationError("patches must contain at most 32 objects")
        if isinstance(patches, list):
            for index, patch in enumerate(patches):
                _validate_prompt_patch(patch, index)
        has_prompt = "prompt" in payload and payload.get("prompt") is not None
        has_diff = payload.get("diff") not in (None, "")
        has_patches = isinstance(patches, list) and len(patches) > 0
        if not has_prompt and not has_diff and not has_patches:
            raise ForgeToolValidationError("edit tools require patches, diff, or prompt")
        if has_prompt and (has_diff or has_patches):
            raise ForgeToolValidationError("prompt full overwrite cannot be combined with patches or diff")
    elif tool == "apply_generation_parameters":
        _allow_keys(payload, {"target", "context_hash", "parameters"})
        _validate_target(payload)
        _safe_text(payload.get("context_hash"), "context_hash", 128, required=True)
        parameters = payload.get("parameters")
        if not isinstance(parameters, dict):
            raise ForgeToolValidationError("parameters must be an object")
        _allow_keys(parameters, {
            "steps", "sampler_name", "scheduler", "cfg_scale", "seed", "width", "height",
            "denoising_strength", "batch_count", "batch_size", "enable_hr", "hr_scale", "hr_upscaler",
        })
        _validate_generation_parameters(parameters)
    elif tool == "search_danbooru_tags":
        _allow_keys(payload, {"query", "queries", "category", "limit"})
        _validate_danbooru_search(payload)
    elif tool == "inspect_danbooru_tags":
        _allow_keys(payload, {"names", "include_wiki"})
        names = payload.get("names")
        if not isinstance(names, list) or not names or len(names) > 12:
            raise ForgeToolValidationError("names must be a list with 1 to 12 items")
        for index, name in enumerate(names):
            _safe_text(name, f"names[{index}]", 160, required=True)
        if "include_wiki" in payload and not isinstance(payload.get("include_wiki"), bool):
            raise ForgeToolValidationError("include_wiki must be a boolean")
    elif tool == "related_danbooru_tags":
        _allow_keys(payload, {"name", "category", "limit"})
        _safe_text(payload.get("name"), "name", 160, required=True)
        _safe_text(payload.get("category"), "category", 32)
        _bounded_integer(payload.get("limit", 12), "limit", 1, 30)
    return dict(payload)


def execute_catalog_tool(tool: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Return logical catalog entries without exposing server-owned paths."""
    kind = str(payload.get("kind") or "")
    if tool not in {"search_resources", "inspect_resource"} or kind not in {"model", "embedding"}:
        raise ForgeToolValidationError("unsupported Forge catalog tool")
    query = _safe_text(payload.get("query"), "query", 512)
    limit = _bounded_integer(payload.get("limit", 20), "limit", 1, 100 if tool == "inspect_resource" else 50)
    cursor = _safe_cursor(payload.get("cursor", "")) if tool == "search_resources" else 0
    raw_items = _model_catalog_items() if kind == "model" else _embedding_catalog_items()
    items = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        identifier = _logical_text(item.get("id"))
        label = _logical_text(item.get("label"))
        if identifier:
            items.append({"id": identifier, "label": label or identifier})
    if tool == "search_resources" and query:
        folded = query.casefold()
        items = [item for item in items if folded in f"{item['id']} {item['label']}".casefold()]
    if tool == "inspect_resource":
        identifier = _safe_text(payload.get("id"), "id", 512, required=True).casefold()
        item = next((entry for entry in items if entry["id"].casefold() == identifier), None)
        if item is None:
            raise ForgeToolValidationError(f"unknown {kind}: {payload.get('id')}")
        return {"ok": True, "kind": kind, **item}
    page = items[cursor : cursor + limit]
    next_cursor = str(cursor + len(page)) if cursor + len(page) < len(items) else ""
    return {
        "ok": True,
        "kind": kind,
        "items": page,
        "total": len(items),
        "limit": limit,
        "cursor": str(cursor),
        "next_cursor": next_cursor,
    }


def _validate_target(payload: dict[str, Any]) -> None:
    target = payload.get("target", "active")
    if target not in {"active", "txt2img", "img2img"}:
        raise ForgeToolValidationError("target must be active, txt2img, or img2img")


def _validate_prompt_field(payload: dict[str, Any]) -> None:
    if payload.get("field") not in {"positive", "negative"}:
        raise ForgeToolValidationError("field must be positive or negative")


def _validate_resource_arguments(payload: dict[str, Any], *, require_id: bool) -> None:
    kind = payload.get("kind")
    if kind not in {"wildcard", "style", "lora", "model", "embedding"}:
        raise ForgeToolValidationError("resource kind is invalid")
    if require_id:
        identifier = _safe_text(payload.get("id"), "id", 512, required=True)
        if _LOCAL_PATH_RE.search(identifier) or ".." in identifier.replace("\\", "/").split("/"):
            raise ForgeToolValidationError("resource id must be logical and must not be a local path")
    _safe_text(payload.get("query"), "query", 512)
    _bounded_integer(payload.get("limit", 20), "limit", 1, 100 if require_id else 50)
    if kind in {"model", "embedding"}:
        _safe_cursor(payload.get("cursor", ""))
    else:
        _safe_text(payload.get("cursor"), "cursor", 256)


def _validate_prompt_patch(value: Any, index: int) -> None:
    if not isinstance(value, dict):
        raise ForgeToolValidationError(f"patches[{index}] must be an object")
    if set(value) - _PATCH_KEYS:
        raise ForgeToolValidationError(f"patches[{index}] contains unsupported fields")
    operation = value.get("operation", "replace")
    if operation not in _PATCH_OPERATIONS:
        raise ForgeToolValidationError(f"patches[{index}].operation is invalid")
    for field in ("find", "replace", "text", "replacement"):
        _safe_text(value.get(field), f"patches[{index}].{field}", 50_000)
    _safe_text(value.get("separator"), f"patches[{index}].separator", 32)
    if "count" in value:
        _bounded_integer(value["count"], f"patches[{index}].count", 1, 10_000)
    if "allow_multiple" in value and not isinstance(value["allow_multiple"], bool):
        raise ForgeToolValidationError(f"patches[{index}].allow_multiple must be a boolean")


def _validate_generation_parameters(value: dict[str, Any]) -> None:
    integer_ranges = {
        "steps": (1, 150),
        "seed": (-1, 2_147_483_647),
        "width": (64, 4_096),
        "height": (64, 4_096),
        "batch_count": (1, 16),
        "batch_size": (1, 16),
    }
    number_ranges = {
        "cfg_scale": (0.0, 50.0),
        "denoising_strength": (0.0, 1.0),
        "hr_scale": (1.0, 4.0),
    }
    for field, (minimum, maximum) in integer_ranges.items():
        if field in value:
            _bounded_integer(value[field], field, minimum, maximum)
    for field, (minimum, maximum) in number_ranges.items():
        if field in value:
            _bounded_number(value[field], field, minimum, maximum)
    for field in ("sampler_name", "scheduler", "hr_upscaler"):
        if field in value:
            _safe_text(value[field], field, 200, required=True)
    if "enable_hr" in value and not isinstance(value["enable_hr"], bool):
        raise ForgeToolValidationError("enable_hr must be a boolean")


def _model_catalog_items() -> list[dict[str, Any]]:
    try:
        from modules import sd_models

        result = []
        for checkpoint in getattr(sd_models, "checkpoints_list", {}).values():
            identifier = _logical_text(getattr(checkpoint, "title", "") or getattr(checkpoint, "name", ""))
            label = _logical_text(getattr(checkpoint, "short_title", "") or getattr(checkpoint, "name", ""))
            if identifier:
                result.append({"id": identifier, "label": label or identifier})
        return sorted(result, key=lambda item: item["label"].casefold())
    except (ImportError, AttributeError):
        return []


def _embedding_catalog_items() -> list[dict[str, str]]:
    try:
        from modules import ui_extra_networks_textual_inversion

        database = getattr(ui_extra_networks_textual_inversion, "embedding_db", None)
        names = getattr(database, "word_embeddings", {})
        result = []
        for name in sorted(names, key=str.casefold):
            identifier = _logical_text(name)
            if identifier:
                result.append({"id": identifier, "label": identifier})
        return result
    except (ImportError, AttributeError):
        return []


def _logical_text(value: Any) -> str:
    text = str(value or "").strip().replace("\\", "/")
    if not text or _LOCAL_PATH_RE.search(text) or _local_path_fragment(text) or ".." in text.split("/"):
        return ""
    return text[:512]


def _bounded_integer(value: Any, field: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ForgeToolValidationError(f"{field} must be an integer between {minimum} and {maximum}")
    return value


def _bounded_number(value: Any, field: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not minimum <= value <= maximum:
        raise ForgeToolValidationError(f"{field} must be a number between {minimum:g} and {maximum:g}")
    return float(value)


def _safe_cursor(value: Any) -> int:
    if value in (None, ""):
        return 0
    if not isinstance(value, str) or not value.isdigit() or len(value) > 8:
        raise ForgeToolValidationError("cursor is invalid")
    return max(0, int(value))


def _validate_danbooru_search(payload: dict[str, Any]) -> None:
    queries = payload.get("queries")
    if queries is not None:
        if not isinstance(queries, list) or not queries or len(queries) > 12:
            raise ForgeToolValidationError("queries must be a list with 1 to 12 items")
        for index, query in enumerate(queries):
            _safe_text(query, f"queries[{index}]", 160, required=True)
    else:
        _safe_text(payload.get("query"), "query", 160, required=True)
    _safe_text(payload.get("category"), "category", 32)
    _bounded_integer(payload.get("limit", 12), "limit", 1, 30)


def _safe_text(value: Any, field: str, maximum: int, *, required: bool = False) -> str:
    if value is None:
        text = ""
    elif isinstance(value, str):
        text = value.strip()
    else:
        raise ForgeToolValidationError(f"{field} must be a string")
    if len(text) > maximum:
        raise ForgeToolValidationError(f"{field} is too large")
    if _LOCAL_PATH_RE.search(text) or _local_path_fragment(text):
        raise ForgeToolValidationError(f"{field} contains a local model or filesystem path, which is server-owned")
    if required and not text:
        raise ForgeToolValidationError(f"{field} is required")
    return text


def _reject_server_owned_fields(value: Any) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = str(key).replace("-", "_").lower()
            if normalized in _FORBIDDEN_KEYS or normalized.endswith("_path") or normalized.endswith("path"):
                raise ForgeToolValidationError("provider credentials, models, local paths, and bridge ownership fields are server-owned")
            _reject_server_owned_fields(child)
    elif isinstance(value, list):
        for child in value:
            _reject_server_owned_fields(child)


def _allow_keys(value: dict[str, Any], allowed: set[str]) -> None:
    if set(value) - allowed:
        raise ForgeToolValidationError("Forge tool arguments contain unsupported fields")


def _local_path_fragment(value: str) -> bool:
    return bool(re.search(r"(?:[A-Za-z]:[\\/]|\\\\[^\s]+|(?:^|\s)(?:\.\.?[\\/]|/))", value, re.IGNORECASE))
