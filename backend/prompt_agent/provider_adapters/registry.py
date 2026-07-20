from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Callable

from ..contracts import StreamRequest
from ..profile_contracts import GEMINI_NATIVE
from .anthropic import ANTHROPIC_CAPABILITIES, stream_anthropic
from .common import AdapterCapabilities, capability_report as build_capability_report
from .gemini import GEMINI_CAPABILITIES, stream_gemini
from .llama_cpp import LLAMA_CPP_CAPABILITIES, stream_llama_cpp
from .openai_compatible import OPENAI_CAPABILITIES, stream_openai_compatible
from .openrouter import OPENROUTER_CAPABILITIES, stream_openrouter


StreamAdapter = Callable[[StreamRequest, dict[str, Any]], AsyncIterator[str]]


class UnsupportedProviderError(ValueError):
    """The profile names a provider without a registered server adapter."""


@dataclass(frozen=True)
class ProviderAdapter:
    id: str
    capabilities: AdapterCapabilities
    stream: StreamAdapter


ADAPTERS = {
    "openai-compatible": ProviderAdapter("openai-compatible", OPENAI_CAPABILITIES, stream_openai_compatible),
    "openrouter": ProviderAdapter("openrouter", OPENROUTER_CAPABILITIES, stream_openrouter),
    "anthropic": ProviderAdapter("anthropic", ANTHROPIC_CAPABILITIES, stream_anthropic),
    "gemini": ProviderAdapter("gemini", GEMINI_CAPABILITIES, stream_gemini),
    "llama-cpp": ProviderAdapter("llama-cpp", LLAMA_CPP_CAPABILITIES, stream_llama_cpp),
}

LLAMA_ONCE_CAPABILITIES = AdapterCapabilities(
    streaming=False,
    tools=False,
    vision=False,
    reasoning=False,
    attachments=False,
    system_prompt=True,
    usage=False,
    abort=False,
)

ALIASES = {
    "openai": "openai-compatible",
    "openai-compatible": "openai-compatible",
    "openai_chat_completions": "openai-compatible",
    "openrouter": "openrouter",
    "anthropic": "anthropic",
    "claude": "anthropic",
    "gemini": "gemini",
    "google": "gemini",
    "llama": "llama-cpp",
    "llama-cpp": "llama-cpp",
    "llama.cpp": "llama-cpp",
}


def provider_id_for(profile: dict[str, Any]) -> str:
    declared = str(profile.get("provider_id") or profile.get("providerId") or "").strip().lower()
    if declared:
        return ALIASES.get(declared, declared)
    model_info = profile.get("model_info", profile.get("modelInfo", {}))
    model_provider = ""
    if isinstance(model_info, dict):
        model_provider = str(model_info.get("provider_id", model_info.get("providerId", ""))).strip().lower()
    if model_provider in ALIASES:
        return ALIASES[model_provider]
    runtime = str(profile.get("runtime") or "")
    if runtime.startswith("llama"):
        return "llama-cpp"
    protocol = str(profile.get("protocol") or "")
    if protocol == "anthropic-native":
        return "anthropic"
    if protocol == GEMINI_NATIVE:
        return "gemini"
    endpoint = str(profile.get("endpoint") or "").lower()
    if "openrouter.ai" in endpoint:
        return "openrouter"
    if "anthropic.com" in endpoint:
        return "anthropic"
    if protocol == "openai-chat-completions":
        return "openai-compatible"
    return "openai-compatible"


def adapter_for_profile(profile: dict[str, Any]) -> ProviderAdapter:
    provider_id = provider_id_for(profile)
    adapter = ADAPTERS.get(provider_id)
    if adapter is None:
        raise UnsupportedProviderError(provider_id)
    return adapter


def capability_report(profile: dict[str, Any]) -> dict[str, Any]:
    adapter = adapter_for_profile(profile)
    supported = LLAMA_ONCE_CAPABILITIES if adapter.id == "llama-cpp" and profile.get("runtime") == "llama-once" else adapter.capabilities
    return build_capability_report(profile, supported)
