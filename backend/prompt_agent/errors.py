from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from prompt_agent.provider_errors import provider_http_status, safe_provider_error


_STRUCTURED_PROVIDER_CODES = frozenset({
    "provider_malformed_response",
    "provider_unexpected_eof",
})


class ProviderProxyError(RuntimeError):
    """An internal provider failure whose public message is fixed and safe."""

    def __init__(self, code: str, *, status_code: int | None = None):
        if code not in _STRUCTURED_PROVIDER_CODES:
            raise ValueError("invalid provider proxy error code")
        super().__init__(code)
        self.code = code
        self.status_code = status_code


@dataclass(frozen=True)
class SanitizedProviderError:
    code: str
    message: str
    status_code: int | None


def sanitize_provider_error(error: BaseException) -> SanitizedProviderError:
    status_code = provider_http_status(error)
    if isinstance(error, ProviderProxyError):
        code = error.code
    elif status_code in {401, 403}:
        code = "provider_auth_error"
    elif status_code == 429:
        code = "provider_rate_limited"
    elif status_code is not None:
        code = "provider_http_error"
    else:
        name = type(error).__name__.lower()
        if "timeout" in name:
            code = "provider_timeout"
        elif "connect" in name or "network" in name or "proxy" in name:
            code = "provider_connection_error"
        else:
            code = "provider_error"

    if code == "provider_malformed_response":
        message = "The provider returned an invalid streaming response."
    elif code == "provider_unexpected_eof":
        message = "The provider stream ended before completion."
    else:
        message = safe_provider_error(error)
    return SanitizedProviderError(code, message, status_code)


@dataclass(frozen=True)
class PromptAgentError:
    code: str
    message: str
    retryable: bool = False
    request_id: str = ""

    def payload(self) -> dict[str, Any]:
        return {"ok": False, "error": asdict(self)}
