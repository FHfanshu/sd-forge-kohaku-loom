from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .migration import merge_legacy_state
from .profile_contracts import LLAMA_ENDPOINT, LLAMA_ONCE, normalize_profile, public_profile
from .secrets import protect_text, unprotect_text


def default_storage_root() -> Path:
    configured = os.environ.get("SD_FORGE_NEO_PROMPT_AGENT_DATA")
    if configured:
        return Path(configured).expanduser().resolve()
    return Path(__file__).resolve().parents[2] / "data" / "prompt-agent"


class ProfileAuthority:
    def __init__(self, root: os.PathLike[str] | str | None = None):
        self.root = default_storage_root() if root is None else Path(root).expanduser().resolve()
        self.profiles_path = self.root / "profiles.json"
        self.secrets_path = self.root / "secrets.dpapi.json"

    def list_state(self) -> dict[str, Any]:
        state = self._load_state()
        secrets = self._read(self.secrets_path, {})
        profiles = [public_profile(item, has_api_key=bool(secrets.get(item["profile_id"]))) for item in state["profiles"]]
        return self._public_state(state, profiles)

    def get(self, profile_id: str) -> dict[str, Any]:
        state = self._load_state()
        item = next((profile for profile in state["profiles"] if profile["profile_id"] == profile_id), None)
        if item is None:
            raise KeyError(profile_id)
        secrets = self._read(self.secrets_path, {})
        return public_profile(item, has_api_key=bool(secrets.get(profile_id)))

    def resolve(self, profile_id: str) -> dict[str, Any]:
        state = self._load_state()
        item = next((profile for profile in state["profiles"] if profile["profile_id"] == profile_id), None)
        if item is None:
            raise KeyError(profile_id)
        result = dict(item)
        encrypted = self._read(self.secrets_path, {}).get(profile_id)
        if encrypted:
            result["api_key"] = unprotect_text(encrypted)
        return result

    def import_state(self, state: dict[str, Any]) -> dict[str, Any]:
        return self.import_legacy_state(state)

    def import_legacy_state(self, state: dict[str, Any]) -> dict[str, Any]:
        current = self._load_state()
        current_secrets = self._read(self.secrets_path, {})
        merged, secrets = merge_legacy_state(current, current_secrets, state, protect_text)
        self._write(self.profiles_path, merged)
        self._write(self.secrets_path, secrets)
        return self.list_state()

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        state = self._load_state()
        item = normalize_profile(payload)
        if any(existing["profile_id"] == item["profile_id"] for existing in state["profiles"]):
            raise ValueError("profile already exists")
        secrets = self._secrets_with_value(item["profile_id"], _secret_from_payload(payload))
        state["profiles"].append(item)
        self._write(self.profiles_path, state)
        self._write(self.secrets_path, secrets)
        return self.get(item["profile_id"])

    def update(self, profile_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        state = self._load_state()
        index = next((index for index, item in enumerate(state["profiles"]) if item["profile_id"] == profile_id), None)
        if index is None:
            raise KeyError(profile_id)
        merged = {**state["profiles"][index], **payload, "profile_id": profile_id}
        item = normalize_profile(merged)
        secrets = None
        if "api_key" in payload or "apiKey" in payload:
            secrets = self._secrets_with_value(profile_id, _secret_from_payload(payload))
        state["profiles"][index] = item
        state = self._state_with_routes(state, state["profiles"])
        self._write(self.profiles_path, state)
        if secrets is not None:
            self._write(self.secrets_path, secrets)
        return self.get(profile_id)

    def delete(self, profile_id: str) -> None:
        state = self._load_state()
        if not any(item["profile_id"] == profile_id for item in state["profiles"]):
            raise KeyError(profile_id)
        if len(state["profiles"]) <= 1:
            raise ValueError("at least one profile must remain")
        state["profiles"] = [item for item in state["profiles"] if item["profile_id"] != profile_id]
        state = self._state_with_routes(state, state["profiles"])
        self._write(self.profiles_path, state)
        secrets = self._read(self.secrets_path, {})
        secrets.pop(profile_id, None)
        self._write(self.secrets_path, secrets)

    def duplicate(self, profile_id: str) -> dict[str, Any]:
        source = self.resolve(profile_id)
        state = self._load_state()
        next_id = f"{profile_id}-copy"
        suffix = 2
        while any(item["profile_id"] == next_id for item in state["profiles"]):
            next_id = f"{profile_id}-copy-{suffix}"
            suffix += 1
        source["profile_id"] = next_id
        source["display_name"] = f"{source.get('display_name', profile_id)} copy"
        return self.create(source)

    def set_default(self, role: str, profile_id: str) -> dict[str, Any]:
        if role not in {"active", "teacher", "session", "naming"}:
            raise ValueError("invalid profile route role")
        state = self._load_state()
        item = next((profile for profile in state["profiles"] if profile["profile_id"] == profile_id), None)
        if item is None or not item.get("enabled", True):
            raise ValueError("profile must be enabled")
        if role in {"active", "teacher"} and item["runtime"] == LLAMA_ONCE:
            raise ValueError(f"{role} profile must support agent streaming")
        if role == "session" and item["runtime"] not in {LLAMA_ENDPOINT, LLAMA_ONCE}:
            raise ValueError("session profile must use a local runtime")
        if role == "naming" and item["runtime"] != LLAMA_ONCE:
            raise ValueError("naming profile must use llama-once")
        state[f"{role}_profile_id"] = profile_id
        self._write(self.profiles_path, state)
        return self.list_state()

    def restore_defaults(self) -> dict[str, Any]:
        self._write(self.profiles_path, self._default_state())
        self._write(self.secrets_path, {})
        return self.list_state()

    def _secrets_with_value(self, profile_id: str, value: str) -> dict[str, str]:
        secrets = self._read(self.secrets_path, {})
        if value:
            secrets[profile_id] = protect_text(value)
        else:
            secrets.pop(profile_id, None)
        return secrets

    def _state_with_routes(self, source: dict[str, Any], profiles: list[dict[str, Any]]) -> dict[str, Any]:
        enabled = [item["profile_id"] for item in profiles if item.get("enabled", True)]
        agent_profiles = [
            item["profile_id"]
            for item in profiles
            if item.get("enabled", True) and item.get("runtime") != LLAMA_ONCE
        ]
        first = agent_profiles[0] if agent_profiles else ""
        result = {"version": 1, "profiles": profiles}
        for role in ("active", "teacher", "session", "naming"):
            value = str(source.get(f"{role}_profile_id") or source.get(f"{role}ProfileId") or "")
            if role == "naming":
                valid = value in enabled and next(item for item in profiles if item["profile_id"] == value).get("runtime") == LLAMA_ONCE
                result[f"{role}_profile_id"] = value if valid else ""
            elif role == "session":
                local = [item["profile_id"] for item in profiles if item["profile_id"] in enabled and item.get("runtime") in {LLAMA_ENDPOINT, LLAMA_ONCE}]
                result[f"{role}_profile_id"] = value if value in local else (local[0] if local else "")
            elif role in {"active", "teacher"}:
                result[f"{role}_profile_id"] = value if value in agent_profiles else first
            else:
                result[f"{role}_profile_id"] = value if value in enabled else first
        return result

    def _load_state(self) -> dict[str, Any]:
        raw = self._read(self.profiles_path, self._default_state())
        if not isinstance(raw, dict):
            raise ValueError("stored profile state must be an object")
        raw_profiles = raw.get("profiles")
        if not isinstance(raw_profiles, list) or not raw_profiles:
            return self._default_state()
        profiles = [normalize_profile(item) for item in raw_profiles]
        state = self._state_with_routes(raw, profiles)
        if state != raw:
            self._write(self.profiles_path, state)
        return state

    def _default_state(self) -> dict[str, Any]:
        return {
            "version": 1,
            "active_profile_id": "local-endpoint",
            "teacher_profile_id": "local-endpoint",
            "session_profile_id": "local-endpoint",
            "naming_profile_id": "",
            "profiles": [normalize_profile({
                "profile_id": "local-endpoint",
                "display_name": "Local OpenAI-compatible endpoint",
                "model_id": "local-model",
                "protocol": "openai-chat-completions",
                "runtime": "llama-endpoint",
                "endpoint": "http://127.0.0.1:8080/v1",
            })],
        }

    @staticmethod
    def _public_state(state: dict[str, Any], profiles: list[dict[str, Any]]) -> dict[str, Any]:
        active = state.get("active_profile_id", "")
        teacher = state.get("teacher_profile_id", "")
        session = state.get("session_profile_id", "")
        naming = state.get("naming_profile_id", "")
        return {
            "version": 2,
            "active_profile_id": active,
            "teacher_profile_id": teacher,
            "session_profile_id": session,
            "naming_profile_id": naming,
            "activeProfileId": active,
            "teacherProfileId": teacher,
            "sessionProfileId": session,
            "namingProfileId": naming,
            "profiles": profiles,
        }

    @staticmethod
    def _read(path: Path, fallback: Any) -> Any:
        if not path.exists():
            return fallback
        return json.loads(path.read_text(encoding="utf-8"))

    @staticmethod
    def _write(path: Path, value: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(json.dumps(value, ensure_ascii=True, indent=2), encoding="utf-8")
        os.replace(temporary, path)
        try:
            path.chmod(0o600)
        except OSError:
            pass


def _secret_from_payload(payload: dict[str, Any]) -> str:
    value = payload.get("api_key") if "api_key" in payload else payload.get("apiKey", "")
    if value is None:
        return ""
    if not isinstance(value, str) or len(value) > 16_384:
        raise ValueError("api_key must be a string with at most 16384 characters")
    return value
