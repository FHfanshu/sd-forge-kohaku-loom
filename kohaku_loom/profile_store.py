from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .assistant_profiles import normalize_model_profile
from .dpapi import protect_text, unprotect_text
from .runtime_paths import LoomRuntimePaths


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=True, indent=2), encoding="utf-8")
    os.replace(temporary, path)
    try:
        path.chmod(0o600)
    except OSError:
        pass


def _read_json(path: Path, fallback: Any) -> Any:
    if not path.exists():
        return fallback
    value = json.loads(path.read_text(encoding="utf-8"))
    return value


class LoomProfileStore:
    def __init__(self, paths: LoomRuntimePaths | None = None):
        self.paths = (paths or LoomRuntimePaths.under()).ensure()

    def import_state(self, state: dict[str, Any]) -> dict[str, Any]:
        profiles = state.get("profiles")
        if not isinstance(profiles, list) or not profiles:
            raise ValueError("profiles must be a non-empty list")
        public_profiles = []
        existing_secrets = _read_json(self.paths.profile_secrets_file, {})
        secrets = {}
        seen = set()
        for raw in profiles:
            if not isinstance(raw, dict):
                raise ValueError("profiles must contain objects")
            profile = normalize_model_profile(
                {
                    **raw,
                    "profile_id": raw.get("profile_id") or raw.get("id"),
                    "model": raw.get("model") or raw.get("model_id"),
                }
            )
            profile_id = profile["profile_id"]
            if profile_id in seen:
                raise ValueError(f"duplicate profile id: {profile_id}")
            seen.add(profile_id)
            api_key = str(profile.pop("api_key", "") or "")
            profile.pop("messages", None)
            profile.pop("_profile_payload", None)
            if api_key:
                secrets[profile_id] = protect_text(api_key)
            elif raw.get("has_api_key") and existing_secrets.get(profile_id):
                secrets[profile_id] = existing_secrets[profile_id]
            public_profiles.append(profile)
        enabled = {profile["profile_id"] for profile in public_profiles}
        public_state = {
            "version": 1,
            "active_profile_id": self._selected(state, "active_profile_id", enabled),
            "teacher_profile_id": self._selected(state, "teacher_profile_id", enabled),
            "session_profile_id": self._selected(state, "session_profile_id", enabled, allow_empty=True),
            "profiles": public_profiles,
        }
        _write_json(self.paths.profiles_file, public_state)
        _write_json(self.paths.profile_secrets_file, secrets)
        return self.list_state()

    def list_state(self) -> dict[str, Any]:
        state = _read_json(self.paths.profiles_file, {"version": 1, "profiles": []})
        secrets = _read_json(self.paths.profile_secrets_file, {})
        result = json.loads(json.dumps(state))
        for profile in result.get("profiles", []):
            profile_id = str(profile.get("profile_id") or "")
            profile["has_api_key"] = bool(secrets.get(profile_id))
        return result

    def resolve(self, profile_id: str) -> dict[str, Any]:
        state = _read_json(self.paths.profiles_file, {"profiles": []})
        profile = next((item for item in state.get("profiles", []) if item.get("profile_id") == profile_id), None)
        if profile is None:
            raise KeyError(profile_id)
        result = json.loads(json.dumps(profile))
        encrypted = _read_json(self.paths.profile_secrets_file, {}).get(profile_id)
        result["api_key"] = unprotect_text(encrypted) if encrypted else ""
        return result

    @staticmethod
    def _selected(state: dict[str, Any], name: str, ids: set[str], allow_empty: bool = False) -> str:
        value = str(state.get(name) or "")
        if allow_empty and not value:
            return ""
        if value not in ids:
            raise ValueError(f"{name} must reference an imported profile")
        return value
