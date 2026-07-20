from __future__ import annotations

import base64
import json
import re
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Iterable


RESOURCE_KINDS = {"wildcard", "style", "lora"}
DEFAULT_LIMIT = 20
MAX_LIMIT = 50
MAX_INSPECT_LIMIT = 100
MAX_TEXT = 12_000
FORGE_ROOT = Path(__file__).resolve().parents[3]


def _text(value: Any, limit: int = 800) -> str:
    result = str(value or "").strip()
    return result if len(result) <= limit else result[:limit] + "..."


def _terms(query: str) -> list[str]:
    return [part.casefold() for part in str(query or "").split() if part.strip()]


def _query_groups(query: str) -> list[list[str]]:
    """Split a query into OR groups; whitespace-separated terms remain ANDed."""
    return [terms for part in str(query or "").split("|") if (terms := _terms(part))]


def _normalized(value: str) -> str:
    return "".join(character for character in value.casefold() if character.isalnum())


def _fuzzy_term_matches(term: str, haystack: str) -> bool:
    if term in haystack:
        return True

    normalized_term = _normalized(term)
    normalized_haystack = _normalized(haystack)
    if not normalized_term:
        return True
    if normalized_term in normalized_haystack:
        return True
    if len(normalized_term) < 4:
        return False

    words = re.findall(r"\w+", haystack, flags=re.UNICODE)
    return any(
        len(normalized_word := _normalized(word)) >= 4
        and SequenceMatcher(None, normalized_term, normalized_word).ratio() >= 0.8
        for word in words
    )


def _matches(query: str, values: Iterable[Any]) -> bool:
    groups = _query_groups(query)
    if not groups:
        return True
    haystack = "\n".join(str(value or "") for value in values).casefold()
    return any(all(_fuzzy_term_matches(term, haystack) for term in group) for group in groups)


def _limit(value: Any, maximum: int = MAX_LIMIT) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = DEFAULT_LIMIT
    return max(1, min(parsed, maximum))


def _cursor_offset(cursor: str) -> int:
    if not cursor:
        return 0
    try:
        raw = base64.urlsafe_b64decode(str(cursor).encode("ascii") + b"===")
        value = json.loads(raw.decode("utf-8"))
        return max(0, int(value.get("offset", 0)))
    except (ValueError, TypeError, UnicodeError, json.JSONDecodeError):
        raise ValueError("invalid resource cursor") from None


def _next_cursor(offset: int) -> str:
    raw = json.dumps({"offset": offset}, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _page(items: list[dict[str, Any]], cursor: str, limit: int) -> dict[str, Any]:
    offset = _cursor_offset(cursor)
    selected = items[offset : offset + limit]
    next_offset = offset + len(selected)
    return {
        "items": selected,
        "total": len(items),
        "limit": limit,
        "cursor": cursor or "",
        "next_cursor": _next_cursor(next_offset) if next_offset < len(items) else "",
    }


def _style_items() -> list[dict[str, Any]]:
    from modules import shared

    result = []
    prompt_styles = getattr(shared, "prompt_styles", None)
    for style in getattr(prompt_styles, "styles", {}).values():
        name = _text(getattr(style, "name", ""), 500)
        if not name:
            continue
        prompt = str(getattr(style, "prompt", "") or "")
        negative = str(getattr(style, "negative_prompt", "") or "")
        result.append(
            {
                "kind": "style",
                "id": name,
                "name": name,
                "prompt": prompt,
                "negative_prompt": negative,
            }
        )
    return sorted(result, key=lambda item: item["name"].casefold())


def _wildcard_root() -> Path:
    try:
        from modules import shared

        configured = getattr(shared.opts, "wildcard_dir", None)
    except (ImportError, AttributeError):
        configured = None
    return Path(configured) if configured else FORGE_ROOT / "extensions" / "sd-dynamic-prompts" / "wildcards"


def _wildcard_manager():
    try:
        from dynamicprompts.wildcards import WildcardManager

        return WildcardManager(_wildcard_root())
    except ImportError:
        return None


def _wildcard_names() -> list[str]:
    manager = _wildcard_manager()
    if manager is not None:
        return sorted(manager.get_collection_names(), key=str.casefold)
    root = _wildcard_root().resolve()
    if not root.is_dir():
        return []
    return sorted(
        (path.relative_to(root).with_suffix("").as_posix() for path in root.rglob("*.txt")),
        key=str.casefold,
    )


def _safe_wildcard_id(resource_id: str) -> str:
    candidate = str(resource_id or "").strip().replace("\\", "/")
    if candidate.startswith("__") and candidate.endswith("__"):
        candidate = candidate[2:-2]
    if not candidate or candidate.startswith("/") or ".." in candidate.split("/"):
        raise ValueError("invalid wildcard id")
    names = _wildcard_names()
    by_fold = {name.casefold(): name for name in names}
    resolved = by_fold.get(candidate.casefold())
    if resolved is None:
        raise ValueError(f"unknown wildcard: {candidate}")
    return resolved


def _wildcard_values(resource_id: str) -> list[str]:
    resolved = _safe_wildcard_id(resource_id)
    manager = _wildcard_manager()
    if manager is not None:
        return [str(item) for item in manager.get_values(resolved)]
    root = _wildcard_root().resolve()
    path = (root / (resolved + ".txt")).resolve()
    if root not in path.parents or not path.is_file():
        raise ValueError(f"unknown wildcard: {resolved}")
    return [line.strip() for line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines() if line.strip()]


def _wildcard_items() -> list[dict[str, Any]]:
    return [
        {"kind": "wildcard", "id": name, "name": name, "token": f"__{name}__"}
        for name in _wildcard_names()
    ]


def _safe_metadata(metadata: Any) -> dict[str, str]:
    if not isinstance(metadata, dict):
        return {}
    preferred = (
        "ss_output_name",
        "ss_base_model_version",
        "ss_network_module",
        "ss_network_dim",
        "ss_resolution",
        "modelspec.architecture",
        "modelspec.title",
        "modelspec.description",
        "modelspec.tags",
    )
    result = {}
    for key in preferred:
        if key in metadata and isinstance(metadata[key], (str, int, float, bool)):
            result[key] = _text(metadata[key], 500)
    return result


def _lora_user_metadata(filename: Any) -> dict[str, Any]:
    try:
        from modules import extra_networks

        value = extra_networks.get_user_metadata(filename)
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def _lora_items() -> list[dict[str, Any]]:
    import networks
    from modules import shared

    default_weight = float(getattr(shared.opts, "extra_networks_default_multiplier", 1.0) or 1.0)
    result = []
    for name, entry in networks.available_networks.items():
        alias = _text(entry.get_alias() if hasattr(entry, "get_alias") else getattr(entry, "alias", name), 500)
        metadata = getattr(entry, "metadata", {})
        user = _lora_user_metadata(getattr(entry, "filename", None))
        preferred = user.get("preferred weight")
        try:
            weight = float(preferred) if preferred not in (None, "", 0, 0.0) else default_weight
        except (TypeError, ValueError):
            weight = default_weight
        result.append(
            {
                "kind": "lora",
                "id": str(name),
                "name": str(name),
                "alias": alias or str(name),
                "path": str(name).replace("\\", "/"),
                "architecture": _text(user.get("sd version") or metadata.get("ss_base_model_version") or "", 200),
                "activation_text": _text(user.get("activation text"), 2_000),
                "negative_text": _text(user.get("negative text"), 2_000),
                "preferred_weight": weight,
                "metadata": _safe_metadata(metadata),
            }
        )
    return sorted(result, key=lambda item: item["name"].casefold())


def _items(kind: str) -> list[dict[str, Any]]:
    if kind == "wildcard":
        return _wildcard_items()
    if kind == "style":
        return _style_items()
    if kind == "lora":
        return _lora_items()
    raise ValueError(f"unknown resource kind: {kind}")


def _find(kind: str, resource_id: str) -> dict[str, Any]:
    wanted = str(resource_id or "").strip().casefold()
    for item in _items(kind):
        if item["id"].casefold() == wanted:
            return item
    raise ValueError(f"unknown {kind}: {resource_id}")


def _search_values(item: dict[str, Any]) -> list[Any]:
    values = [item.get("id"), item.get("name"), item.get("alias"), item.get("path")]
    values.extend((item.get("prompt"), item.get("negative_prompt"), item.get("activation_text"), item.get("negative_text")))
    values.extend((item.get("metadata") or {}).values())
    return values


def _search_preview(item: dict[str, Any]) -> dict[str, Any]:
    result = {key: value for key, value in item.items() if key not in {"metadata", "path"}}
    for key in ("prompt", "negative_prompt", "activation_text", "negative_text"):
        if key in result:
            result[key] = _text(result[key], 280)
    if item.get("metadata"):
        result["metadata"] = item["metadata"]
    return result


def search_resources(kind: str, query: str = "", limit: int = DEFAULT_LIMIT, cursor: str = "") -> dict[str, Any]:
    normalized = str(kind or "").strip().lower()
    if normalized not in RESOURCE_KINDS:
        raise ValueError(f"unknown resource kind: {normalized}")
    matches = [_search_preview(item) for item in _items(normalized) if _matches(query, _search_values(item))]
    page = _page(matches, cursor, _limit(limit))
    return {"ok": True, "kind": normalized, "query": str(query or ""), **page}


def inspect_resource(
    kind: str,
    resource_id: str,
    query: str = "",
    limit: int = DEFAULT_LIMIT,
    cursor: str = "",
) -> dict[str, Any]:
    normalized = str(kind or "").strip().lower()
    if normalized == "wildcard":
        resolved = _safe_wildcard_id(resource_id)
        values = [_text(value, 2_000) for value in _wildcard_values(resolved) if _matches(query, [value])]
        page = _page([{"value": value} for value in values], cursor, _limit(limit, MAX_INSPECT_LIMIT))
        return {"ok": True, "kind": normalized, "id": resolved, "name": resolved, "token": f"__{resolved}__", "query": str(query or ""), **page}
    if normalized not in RESOURCE_KINDS:
        raise ValueError(f"unknown resource kind: {normalized}")
    item = _find(normalized, resource_id)
    result = dict(item)
    result.pop("path", None)
    for key in ("prompt", "negative_prompt"):
        if key in result:
            result[key] = _text(result[key], MAX_TEXT)
    return {"ok": True, **result}
