from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from ..contracts import StreamRequest
from .common import AdapterCapabilities
from .openai_compatible import stream_openai_compatible


LLAMA_CPP_CAPABILITIES = AdapterCapabilities(
    streaming=True,
    tools=True,
    vision=True,
    reasoning=True,
    attachments=True,
    system_prompt=True,
    usage=True,
    abort=True,
)


async def stream_llama_cpp(request: StreamRequest, profile: dict[str, Any]) -> AsyncIterator[str]:
    async for frame in stream_openai_compatible(request, profile, provider_id="llama-cpp"):
        yield frame
