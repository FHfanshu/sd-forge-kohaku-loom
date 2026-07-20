from __future__ import annotations

import ipaddress
from typing import Any
from urllib.parse import urlparse
from urllib.request import getproxies, proxy_bypass


def _payload_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().lower() in {"1", "true", "yes", "on", "enabled", "enable"}


def http_transport_summary(endpoint: str) -> str:
    parsed = urlparse(str(endpoint or ""))
    host = parsed.hostname or ""
    if not host:
        return "direct"
    try:
        if host.lower() == "localhost" or ipaddress.ip_address(host).is_loopback:
            return "direct (local endpoint)"
    except ValueError:
        pass
    try:
        if proxy_bypass(host):
            return "direct (proxy bypass)"
    except OSError:
        pass
    proxies = getproxies()
    proxy = proxies.get(parsed.scheme.lower()) or proxies.get("all")
    if not proxy:
        return "direct"
    proxy_url = urlparse(proxy if "://" in proxy else f"http://{proxy}")
    proxy_host = proxy_url.hostname or "configured proxy"
    proxy_port = f":{proxy_url.port}" if proxy_url.port else ""
    proxy_scheme = proxy_url.scheme or "http"
    return f"system/environment proxy {proxy_scheme}://{proxy_host}{proxy_port}"
