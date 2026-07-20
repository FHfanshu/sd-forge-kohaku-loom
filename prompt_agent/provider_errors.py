from __future__ import annotations

import re


def provider_http_status(error: BaseException) -> int | None:
    response = getattr(error, "response", None)
    candidates = (
        getattr(error, "status_code", None),
        getattr(error, "code", None),
        getattr(error, "status", None),
        getattr(response, "status_code", None),
        getattr(response, "status", None),
    )
    for candidate in candidates:
        if isinstance(candidate, int) and not isinstance(candidate, bool) and 100 <= candidate <= 599:
            return candidate
        if isinstance(candidate, str) and candidate.isdigit():
            status = int(candidate)
            if 100 <= status <= 599:
                return status
    match = re.search(r"(?<!\d)([1-5]\d{2})(?!\d)", str(error))
    return int(match.group(1)) if match else None


def safe_provider_error(error: BaseException) -> str:
    status = provider_http_status(error)
    if status in {401, 403}:
        return f"Provider rejected the configured credentials (HTTP {status})."
    if status == 407:
        return "The configured proxy requires authentication (HTTP 407)."
    if status is not None:
        return f"Provider request failed (HTTP {status})."
    name = type(error).__name__.lower()
    if "proxy" in name:
        return "The configured proxy connection failed."
    if "timeout" in name:
        return "The provider request timed out."
    if "ssl" in name or "tls" in name or "certificate" in name:
        return "TLS certificate validation failed."
    if "connect" in name or "network" in name:
        return "The provider could not be reached. Check DNS, the proxy, and the endpoint."
    return f"Provider request failed ({type(error).__name__})."
