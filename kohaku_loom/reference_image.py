from __future__ import annotations

import gc
import subprocess
from pathlib import Path
from typing import Any

from PIL import Image

from .constants import (
    DEFAULT_LOCAL_CONTEXT_TOKENS,
    DEFAULT_LOCAL_ASSISTANT_MODEL,
    DEFAULT_VISION_MODEL_PRESET,
    REFERENCE_IMAGE_ANALYSIS_SYSTEM,
    REFERENCE_IMAGE_STYLE_PROMPT,
)
from .image_payloads import _image_data_url, _image_from_data_url
from .llama_runtime import _free_port, _local_endpoint_ready, _post_local_chat, _wait_server
from .model_paths import resolve_llama_server, resolve_vision_model_pair, vision_preset_alias
from .response_text import _extract_message_text
from .utils import _payload_bool

def analyze_reference_image(payload: dict[str, Any]) -> dict[str, Any]:
    image_data = str(payload.get("image") or payload.get("data_url") or "").strip()
    if not image_data:
        raise RuntimeError("missing reference image")
    image = _image_from_data_url(image_data)
    messages = _reference_image_messages(image)
    enable_thinking = _payload_bool(payload.get("enable_thinking", payload.get("vision_thinking")), False)
    timeout = int(payload.get("timeout") or 120)
    max_tokens = int(payload.get("max_tokens") or (1600 if enable_thinking else 700))
    temperature = float(payload.get("temperature") or 0.15)
    top_p = float(payload.get("top_p") or 0.9)
    vision_preset = str(payload.get("vision_preset") or DEFAULT_VISION_MODEL_PRESET).strip()
    vision_model = str(payload.get("vision_model") or vision_preset_alias(vision_preset) or payload.get("local_model") or DEFAULT_LOCAL_ASSISTANT_MODEL).strip()

    local_endpoint = str(payload.get("vision_endpoint") or payload.get("local_endpoint") or "").strip().rstrip("/")
    if local_endpoint and _local_endpoint_ready(local_endpoint):
        try:
            response = _post_local_chat(
                local_endpoint,
                messages,
                max_tokens,
                temperature,
                top_p,
                timeout,
                enable_thinking,
                vision_model,
            )
            text = _extract_message_text(response["choices"][0]["message"])
            return {
                "text": text,
                "model": vision_model,
                "vision_preset": vision_preset,
                "endpoint": local_endpoint,
                "thinking_enabled": enable_thinking,
                "source": "existing-local-endpoint",
            }
        except Exception:
            pass

    llama_server_path = resolve_llama_server(str(payload.get("llama_server_path") or ""))
    model_path, mmproj_path, vision_alias = resolve_vision_model_pair(
        vision_preset,
        str(payload.get("vision_model_path") or payload.get("model_path") or ""),
        str(payload.get("vision_mmproj_path") or payload.get("mmproj_path") or ""),
        True,
    )

    port = _free_port()
    proc: subprocess.Popen | None = None
    try:
        args = [
            llama_server_path,
            "-m",
            model_path,
            "-mm",
            mmproj_path,
            "-ngl",
            "all",
            "-c",
            str(int(payload.get("n_ctx") or DEFAULT_LOCAL_CONTEXT_TOKENS)),
            "-fa",
            "on",
            "-np",
            "1",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--alias",
            vision_alias,
            "--jinja",
        ]
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=creationflags)
        endpoint = f"http://127.0.0.1:{port}/v1"
        _wait_server(endpoint, timeout)
        response = _post_local_chat(
            endpoint,
            messages,
            max_tokens,
            temperature,
            top_p,
            timeout,
            enable_thinking,
            vision_alias,
        )
        text = _extract_message_text(response["choices"][0]["message"])
        return {
            "text": text,
            "model": Path(model_path).name,
            "mmproj": Path(mmproj_path).name,
            "vision_preset": vision_preset,
            "thinking_enabled": enable_thinking,
            "source": "one-shot-local-gguf",
        }
    finally:
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        gc.collect()
def _reference_image_messages(image: Image.Image) -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": REFERENCE_IMAGE_ANALYSIS_SYSTEM},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": REFERENCE_IMAGE_STYLE_PROMPT},
                {"type": "image_url", "image_url": {"url": _image_data_url(image, max_side=1024)}},
            ],
        },
    ]
