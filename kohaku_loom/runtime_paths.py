from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


EXTENSION_ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class LoomRuntimePaths:
    root: Path
    venv: Path
    config: Path
    sessions: Path
    cache: Path
    runtime: Path
    secrets: Path

    @classmethod
    def under(cls, extension_root: Path = EXTENSION_ROOT) -> "LoomRuntimePaths":
        root = extension_root / ".loom"
        return cls(
            root=root,
            venv=root / "venv",
            config=root / "config",
            sessions=root / "sessions",
            cache=root / "cache",
            runtime=root / "runtime",
            secrets=root / "secrets",
        )

    def ensure(self) -> "LoomRuntimePaths":
        for path in (
            self.root,
            self.config,
            self.sessions,
            self.cache,
            self.runtime,
            self.secrets,
        ):
            path.mkdir(parents=True, exist_ok=True)
        return self

    @property
    def python(self) -> Path:
        return self.venv / "Scripts" / "python.exe"

    @property
    def lock_file(self) -> Path:
        return self.runtime / "runtime-lock.json"

    @property
    def state_file(self) -> Path:
        return self.runtime / "sidecar.json"

    @property
    def profiles_file(self) -> Path:
        return self.config / "profiles.json"

    @property
    def profile_secrets_file(self) -> Path:
        return self.secrets / "profiles.dpapi.json"
