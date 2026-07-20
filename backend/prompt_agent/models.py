"""Safe model metadata projections for the browser profile cache."""

from __future__ import annotations

from typing import Any


def public_models(state: dict[str, Any]) -> dict[str, Any]:
    models: list[dict[str, Any]] = []
    for index, profile in enumerate(state.get("profiles", [])):
        if not isinstance(profile, dict):
            continue
        model_info = profile.get("modelInfo", profile.get("model_info", {}))
        if not isinstance(model_info, dict):
            model_info = {}
        capabilities = profile.get("capabilities", {})
        if not isinstance(capabilities, dict):
            capabilities = {}
        model_id = _text(profile.get("id", profile.get("profile_id", ""))) or f"model-{index + 1}"
        models.append({
            "id": model_id,
            "modelId": _text(profile.get("modelId", profile.get("model_id", ""))) or "model",
            "displayName": _text(profile.get("displayName", profile.get("display_name", ""))) or "Model",
            "enabled": bool(profile.get("enabled", True)),
            "protocol": _text(profile.get("protocol", "")),
            "runtime": _text(profile.get("runtime", "")),
            "hasApiKey": bool(profile.get("hasApiKey", profile.get("has_api_key", False))),
            "capabilities": {
                key: bool(capabilities[key])
                for key in ("tools", "vision", "streaming", "reasoning")
                if key in capabilities
            },
            "modelInfo": _model_info(model_info),
            "localModelConfigured": bool(profile.get("localModelConfigured", profile.get("local_model_configured", False))),
            "mmprojConfigured": bool(profile.get("mmprojConfigured", profile.get("mmproj_configured", False))),
            "llamaServerConfigured": bool(profile.get("llamaServerConfigured", profile.get("llama_server_configured", False))),
        })
    return {"version": 1, "models": models}


def _model_info(value: dict[str, Any]) -> dict[str, Any]:
    efforts = value.get("reasoningEfforts", value.get("reasoning_efforts", []))
    if not isinstance(efforts, list):
        efforts = []
    return {
        "source": _text(value.get("source")),
        "providerId": _text(value.get("providerId", value.get("provider_id"))),
        "matchedModelId": _text(value.get("matchedModelId", value.get("matched_model_id"))),
        "contextLimit": _number(value.get("contextLimit", value.get("context_limit"))),
        "outputLimit": _number(value.get("outputLimit", value.get("output_limit"))),
        "temperatureSupported": bool(value.get("temperatureSupported", value.get("temperature_supported", True))),
        "reasoningToggle": bool(value.get("reasoningToggle", value.get("reasoning_toggle", False))),
        "reasoningEfforts": _safe_efforts(efforts),
        "syncedAt": _text(value.get("syncedAt", value.get("synced_at"))),
    }


def _text(value: Any) -> str:
    text = str(value or "").strip()
    if text.startswith(("/", "\\", "./", "../")) or "\\" in text or (len(text) > 1 and text[1] == ":"):
        return ""
    return text[:512]


def _number(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _safe_efforts(value: list[Any]) -> list[str]:
    result: list[str] = []
    for item in value:
        if not isinstance(item, str):
            continue
        text = _text(item)
        if text and len(text) <= 64 and text not in result:
            result.append(text)
    return result
