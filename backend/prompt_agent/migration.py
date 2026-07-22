"""One-way compatibility import for profiles owned by the old runtime.

The importer accepts a caller-supplied snapshot only.  It deliberately does not
discover files, inspect ``.loom``, or run during normal authority startup.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .profile_contracts import LLAMA_ONCE, migrate_legacy_profile, normalize_profile


def merge_legacy_state(
    current_state: dict[str, Any],
    current_secrets: dict[str, str],
    imported_state: dict[str, Any],
    protect: Callable[[str], str],
) -> tuple[dict[str, Any], dict[str, str]]:
    if not isinstance(imported_state, dict):
        raise ValueError("import state must be an object")
    nested = imported_state.get("state")
    if isinstance(nested, dict):
        imported_state = nested
    raw_profiles = imported_state.get("profiles")
    if not isinstance(raw_profiles, list) or not raw_profiles:
        raise ValueError("profiles must be a non-empty list")

    # An explicit migration replaces the authority snapshot.  Repeating the
    # same import therefore cannot append duplicates or retain stale secrets.
    profiles: list[dict[str, Any]] = []
    secrets: dict[str, str] = {}
    imported_ids: set[str] = set()

    for raw in raw_profiles:
        if not isinstance(raw, dict):
            raise ValueError("profiles must contain objects")
        item = normalize_profile(migrate_legacy_profile(raw))
        profile_id = item["profile_id"]
        if profile_id in imported_ids:
            raise ValueError(f"duplicate profile id: {profile_id}")
        imported_ids.add(profile_id)
        profiles.append(item)

        if "api_key" in raw or "apiKey" in raw:
            value = raw.get("api_key") if "api_key" in raw else raw.get("apiKey")
            if value is None:
                value = ""
            if not isinstance(value, str):
                raise ValueError("api_key must be a string")
            if len(value) > 16_384:
                raise ValueError("api_key is too large")
            if value:
                secrets[profile_id] = protect(value)
            elif (raw.get("has_api_key") is True or raw.get("hasApiKey") is True) and current_secrets.get(profile_id):
                secrets[profile_id] = current_secrets[profile_id]
            else:
                secrets.pop(profile_id, None)
        elif "has_api_key" in raw or "hasApiKey" in raw:
            # An explicit false marker means the old snapshot intentionally
            # had no key. An omitted marker imports no key.
            marker = raw.get("has_api_key", raw.get("hasApiKey"))
            if not isinstance(marker, bool):
                raise ValueError("has_api_key must be a boolean")
            if marker and current_secrets.get(profile_id):
                secrets[profile_id] = current_secrets[profile_id]
            elif not marker:
                secrets.pop(profile_id, None)

    return _with_routes(current_state, imported_state, profiles), secrets


def _with_routes(
    current_state: dict[str, Any],
    imported_state: dict[str, Any],
    profiles: list[dict[str, Any]],
) -> dict[str, Any]:
    enabled = [item["profile_id"] for item in profiles if item.get("enabled", True)]
    enabled_set = set(enabled)
    first_enabled = enabled[0] if enabled else ""
    result = {"version": 1, "profiles": profiles}
    for role in ("active", "session", "naming"):
        requested = _route_value(imported_state, role)
        if not requested:
            requested = _route_value(current_state, role)
        if role == "naming":
            valid = requested in enabled_set and _profile(profiles, requested).get("runtime") == LLAMA_ONCE
            result[f"{role}_profile_id"] = requested if valid else ""
        elif role == "session":
            local = [
                item["profile_id"]
                for item in profiles
                if item.get("enabled", True) and item.get("runtime") == LLAMA_ONCE
            ]
            result[f"{role}_profile_id"] = requested if requested in local else (local[0] if local else "")
        else:
            result[f"{role}_profile_id"] = requested if requested in enabled_set else first_enabled
    return result


def _route_value(state: dict[str, Any], role: str) -> str:
    value = state.get(f"{role}_profile_id")
    if value is None:
        value = state.get(f"{role}ProfileId")
    return str(value or "")


def _profile(profiles: list[dict[str, Any]], profile_id: str) -> dict[str, Any]:
    return next(item for item in profiles if item["profile_id"] == profile_id)
