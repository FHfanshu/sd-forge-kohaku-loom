from __future__ import annotations

import json
import socket
import time
import urllib.error
import urllib.request
from typing import Any

def _local_endpoint_ready(endpoint: str) -> bool:
    try:
        with urllib.request.urlopen(endpoint.rstrip("/") + "/models", timeout=2) as resp:
            return resp.status < 500
    except Exception:
        return False
def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_server(endpoint: str, timeout: int) -> None:
    deadline = time.time() + max(10, timeout)
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(endpoint.rstrip("/") + "/models", timeout=2) as resp:
                if resp.status < 500:
                    return
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            time.sleep(0.5)
    raise RuntimeError(f"llama-server 未就绪: {last_error}")


def _post_local_chat(
    endpoint: str,
    messages: list[dict[str, Any]],
    max_tokens: int,
    temperature: float,
    top_p: float,
    timeout: int,
    enable_thinking: bool,
    model: str = "local-gguf-once",
) -> dict[str, Any]:
    payload = {
        "model": model,
        "messages": messages,
        "temperature": float(temperature),
        "top_p": float(top_p),
        "max_tokens": int(max_tokens),
        "stream": False,
        "chat_template_kwargs": {"enable_thinking": bool(enable_thinking)},
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        endpoint.rstrip("/") + "/chat/completions",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=int(timeout)) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"llama-server HTTP {exc.code}: {body}") from exc
