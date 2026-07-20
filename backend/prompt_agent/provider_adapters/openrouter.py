from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from ..contracts import StreamRequest
from .common import AdapterCapabilities
from .openai_compatible import stream_openai_compatible


OPENROUTER_CAPABILITIES = AdapterCapabilities()
OPENROUTER_HEADERS = {
    "HTTP-Referer": "https://github.com/lllyasviel/stable-diffusion-webui",
    "X-Title": "SD Forge Neo Prompt Agent",
}


async def stream_openrouter(request: StreamRequest, profile: dict[str, Any]) -> AsyncIterator[str]:
    async for frame in stream_openai_compatible(
        request,
        profile,
        provider_id="openrouter",
        extra_headers=OPENROUTER_HEADERS,
        reasoning_format="openrouter",
    ):
        yield frame
