from __future__ import annotations

from typing import Any


DEFAULT_LOCALE = "en"
SUPPORTED_LOCALES = ("zh-CN", "en")


TRANSLATIONS: dict[str, dict[str, str]] = {
    "zh-CN": {
        "assistant.attach": "附图",
        "assistant.clear": "清空",
        "assistant.close": "关闭",
        "assistant.edit": "编辑",
        "assistant.empty.title": "从当前提示词开始",
        "assistant.input.placeholder": "描述你想分析、补充或修改的提示词内容...",
        "assistant.launcher": "LLM 助手",
        "assistant.quick.analyze": "分析结构",
        "assistant.quick.compose": "强化构图",
        "assistant.quick.refine": "精炼表达",
        "assistant.read": "读取",
        "assistant.read_prompt": "Read the current prompt and WebUI style template. Briefly summarize the composition, trigger words, and spatial relationships they describe. If both are empty, say they are empty.",
        "assistant.rewind": "编辑并重新发送",
        "assistant.send": "发送",
        "assistant.settings": "设置",
        "assistant.stop": "终止",
        "assistant.title": "LLM 提示词助手",
        "assistant.role.assistant": "助手",
        "assistant.role.error": "错误",
        "assistant.role.user": "你",
        "common.off": "关",
        "common.on": "开",
        "settings.api_key": "API 密钥",
        "settings.api_key.hide": "隐藏密钥",
        "settings.api_key.placeholder": "API 密钥",
        "settings.api_key.show": "显示密钥",
        "settings.backend": "后端",
        "settings.backend.local_endpoint": "本地接入点",
        "settings.backend.local_qwen_once": "本地模型一次性",
        "settings.local_endpoint": "文本接入点",
        "settings.local_endpoint.placeholder": "http://127.0.0.1:8080/v1",
        "settings.local_agent_params": "本地代理参数",
        "settings.local_max_tokens": "本地最大 token 数",
        "settings.local_model": "文本模型名称",
        "settings.local_model_preset": "模型预设",
        "settings.local_model.placeholder": "hauhau-qwen3.5-9b-uncensored",
        "settings.local_no_api_key": "本地后端无需 API key",
        "settings.local_shared_model": "本地共享多模态模型",
        "settings.main_backend": "主后端",
        "settings.max_tokens": "最大 token 数",
        "settings.model": "模型",
        "settings.model.placeholder": "Gemini 模型名称",
        "settings.nav.local_qwen": "本地模型",
        "settings.nav.remote": "远端模型",
        "settings.nav.route": "模型路由",
        "settings.n_ctx": "上下文长度 n_ctx",
        "settings.page.endpoint": "接入点",
        "settings.page.connection": "连接设置",
        "settings.page.local_params": "代理参数",
        "settings.page.local_paths": "接入/路径",
        "settings.page.main": "主后端",
        "settings.page.params": "参数",
        "settings.page.paths": "路径 / 上下文",
        "settings.page.policy": "策略",
        "settings.page.preset": "预设",
        "settings.page.shared_model": "共享模型",
        "settings.page.text": "文本",
        "settings.page.text_model": "文本模型",
        "settings.page.vision": "视觉",
        "settings.page.vision_model": "视觉模型",
        "settings.page.vision_paths": "视觉路径",
        "settings.page.workflow": "工作流策略",
        "settings.preset.custom": "自定义",
        "settings.primary_nav": "一级设置分类",
        "settings.reasoning_effort": "推理强度",
        "settings.reasoning_low": "低",
        "settings.reasoning_high": "高",
        "settings.reasoning_max": "最大",
        "settings.remote_endpoint": "远端接入点",
        "settings.remote_endpoint.placeholder": "OpenAI-compatible Base URL",
        "settings.remote_params": "远端参数",
        "settings.remote_preset": "远端预设",
        "settings.sanitize": "脱敏占位符",
        "settings.sanitize.title": "发送到 Gemini 前把敏感提示词替换为占位符，返回工具参数时本地还原",
        "settings.sub_nav": "二级设置分类",
        "settings.teacher_mode": "教师策略",
        "settings.teacher_mode.qwen_redact": "本地模型脱敏",
        "settings.teacher_mode.regex": "仅占位符脱敏",
        "settings.teacher_mode.title": "Gemini 教师前置脱敏策略",
        "settings.title": "助手设置",
        "settings.local_text_thinking": "文本推理",
        "settings.vision_endpoint": "视觉接入点",
        "settings.vision_model": "模型别名",
        "settings.vision_model_path": "模型 GGUF 路径",
        "settings.vision_model_path.placeholder": "视觉模型 GGUF 路径",
        "settings.vision_mmproj_path": "mmproj 路径",
        "settings.vision_mmproj_path.placeholder": "对应 mmproj GGUF 路径",
        "settings.vision_preset": "视觉预设",
        "settings.vision_thinking": "视觉推理",
        "settings.workflow_preset": "工作流预设",
        "settings.workflow.gemini_main_local_filter": "Gemini 3.1 Pro 主力 + 本地 Gemma 脱敏",
        "settings.workflow.local_executor_gemini_adviser": "本地 Gemma 工具执行 + Gemini adviser",
        "settings.qwen_text": "本地模型文本",
        "settings.qwen_vision": "本地模型视觉",
    },
    "en": {
        "assistant.attach": "Attach image",
        "assistant.clear": "Clear",
        "assistant.close": "Close",
        "assistant.edit": "Edit",
        "assistant.empty.title": "Start from the current prompt",
        "assistant.input.placeholder": "Describe what you want to analyze, add, or change...",
        "assistant.launcher": "LLM Assistant",
        "assistant.quick.analyze": "Analyze structure",
        "assistant.quick.compose": "Strengthen composition",
        "assistant.quick.refine": "Refine wording",
        "assistant.read": "Read",
        "assistant.read_prompt": "Read the current prompt and WebUI style template. Briefly summarize the composition, trigger words, and spatial relationships they describe. If both are empty, say they are empty.",
        "assistant.rewind": "Edit and resend",
        "assistant.send": "Send",
        "assistant.settings": "Settings",
        "assistant.stop": "Stop",
        "assistant.title": "LLM Prompt Assistant",
        "assistant.role.assistant": "Assistant",
        "assistant.role.error": "Error",
        "assistant.role.user": "You",
        "common.off": "Off",
        "common.on": "On",
        "settings.api_key": "API key",
        "settings.api_key.hide": "Hide API key",
        "settings.api_key.placeholder": "API key",
        "settings.api_key.show": "Show API key",
        "settings.backend": "Backend",
        "settings.backend.local_endpoint": "Local endpoint",
        "settings.backend.local_qwen_once": "Local model one-shot",
        "settings.local_endpoint": "Text endpoint",
        "settings.local_endpoint.placeholder": "http://127.0.0.1:8080/v1",
        "settings.local_agent_params": "Local Agent Parameters",
        "settings.local_max_tokens": "Local max tokens",
        "settings.local_model": "Text model name",
        "settings.local_model_preset": "Model preset",
        "settings.local_model.placeholder": "hauhau-qwen3.5-9b-uncensored",
        "settings.local_no_api_key": "Local backends do not need an API key",
        "settings.local_shared_model": "Local Shared Multimodal Model",
        "settings.main_backend": "Main Backend",
        "settings.max_tokens": "Max tokens",
        "settings.model": "Model",
        "settings.model.placeholder": "Gemini model name",
        "settings.nav.local_qwen": "Local Model",
        "settings.nav.remote": "Remote Models",
        "settings.nav.route": "Model Route",
        "settings.n_ctx": "Context length n_ctx",
        "settings.page.endpoint": "Endpoint",
        "settings.page.connection": "Connection Settings",
        "settings.page.local_params": "Agent Parameters",
        "settings.page.local_paths": "Endpoint / Paths",
        "settings.page.main": "Main Backend",
        "settings.page.params": "Parameters",
        "settings.page.paths": "Paths / Context",
        "settings.page.policy": "Policy",
        "settings.page.preset": "Preset",
        "settings.page.shared_model": "Shared Model",
        "settings.page.text": "Text",
        "settings.page.text_model": "Text Model",
        "settings.page.vision": "Vision",
        "settings.page.vision_model": "Vision Model",
        "settings.page.vision_paths": "Vision Paths",
        "settings.page.workflow": "Workflow Policy",
        "settings.preset.custom": "Custom",
        "settings.primary_nav": "Primary settings categories",
        "settings.reasoning_effort": "Reasoning effort",
        "settings.reasoning_low": "Low",
        "settings.reasoning_high": "High",
        "settings.reasoning_max": "Max",
        "settings.remote_endpoint": "Remote Endpoint",
        "settings.remote_endpoint.placeholder": "OpenAI-compatible Base URL",
        "settings.remote_params": "Remote Parameters",
        "settings.remote_preset": "Remote Preset",
        "settings.sanitize": "Sanitize placeholders",
        "settings.sanitize.title": "Replace sensitive prompt text with placeholders before sending to Gemini, then restore tool arguments locally",
        "settings.sub_nav": "Secondary settings categories",
        "settings.teacher_mode": "Teacher policy",
        "settings.teacher_mode.qwen_redact": "Local model redaction",
        "settings.teacher_mode.regex": "Placeholder redaction only",
        "settings.teacher_mode.title": "Gemini teacher pre-redaction policy",
        "settings.title": "Assistant Settings",
        "settings.local_text_thinking": "Text thinking",
        "settings.vision_endpoint": "Vision endpoint",
        "settings.vision_model": "Model alias",
        "settings.vision_model_path": "Model GGUF path",
        "settings.vision_model_path.placeholder": "Vision model GGUF path",
        "settings.vision_mmproj_path": "mmproj path",
        "settings.vision_mmproj_path.placeholder": "Matching mmproj GGUF path",
        "settings.vision_preset": "Vision preset",
        "settings.vision_thinking": "Vision thinking",
        "settings.workflow_preset": "Workflow preset",
        "settings.workflow.gemini_main_local_filter": "Gemini 3.1 Pro main + local Gemma redaction",
        "settings.workflow.local_executor_gemini_adviser": "Local Gemma tool executor + Gemini adviser",
        "settings.qwen_text": "Local Model Text",
        "settings.qwen_vision": "Local Model Vision",
    },
}

_PROFILE_TRANSLATIONS = {
    "zh-CN": {
        "profiles.title": "模型配置档案", "profiles.list": "模型配置档案", "profiles.close": "关闭",
        "profiles.status.autosave": "修改会自动保存", "profiles.status.saved": "已保存", "profiles.status.invalid": "请检查该配置项。",
        "profiles.section.basic": "基本信息", "profiles.section.connection": "连接配置", "profiles.section.capabilities": "能力配置", "profiles.section.generation": "生成参数", "profiles.section.local": "本地运行",
        "profiles.id": "配置 ID", "profiles.display_name": "显示名称", "profiles.model_id": "模型 ID", "profiles.enabled": "已启用", "profiles.disabled": "已禁用", "profiles.active": "当前主模型",
        "profiles.protocol": "API 协议", "profiles.protocol.gemini": "Gemini Native", "profiles.protocol.openai": "OpenAI Chat Completions", "profiles.protocol.abbr.gemini": "GEM", "profiles.protocol.abbr.openai": "OAI",
        "profiles.runtime": "运行方式", "profiles.runtime.remote": "远端 HTTP", "profiles.runtime.endpoint": "llama.cpp Endpoint", "profiles.runtime.once": "llama.cpp 一次性",
        "profiles.endpoint": "Endpoint", "profiles.fallback_endpoints": "备用 Endpoint（每行一个）", "profiles.api_key": "API Key", "profiles.api_key.show": "显示", "profiles.api_key.hide": "隐藏",
        "profiles.capability.tools": "工具调用", "profiles.capability.vision": "视觉输入", "profiles.capability.streaming": "流式响应", "profiles.capability.reasoning": "推理参数",
        "profiles.temperature": "Temperature", "profiles.top_p": "Top P", "profiles.max_tokens": "最大 Tokens", "profiles.reasoning_effort": "推理强度", "profiles.reasoning.low": "低", "profiles.reasoning.high": "高", "profiles.reasoning.max": "最大", "profiles.timeout": "超时（秒）",
        "profiles.teacher_mode": "教师脱敏模式", "profiles.teacher_mode.qwen": "本地 Qwen 脱敏", "profiles.teacher_mode.regex": "仅占位符脱敏", "profiles.sanitize_sensitive": "敏感内容占位符脱敏", "profiles.teacher_profile": "教师档案",
        "profiles.model_path": "GGUF 路径", "profiles.mmproj_path": "mmproj 路径", "profiles.llama_server_path": "llama-server 路径", "profiles.n_ctx": "上下文长度", "profiles.n_gpu_layers": "GPU Layers", "profiles.thinking": "Thinking",
        "profiles.add": "新增", "profiles.duplicate": "复制", "profiles.delete": "删除", "profiles.set_active": "设为主模型", "profiles.restore": "恢复默认配置", "profiles.new_name": "新模型配置", "profiles.new_model_id": "model-id",
        "profiles.delete.confirm": "确定删除这个模型配置吗？", "profiles.delete.last_enabled": "至少需要保留一个已启用的模型配置。", "profiles.active.disabled": "请先启用该配置，再设为主模型。", "profiles.restore.confirm": "确定用默认配置替换全部模型档案吗？",
        "profiles.test": "测试连接", "profiles.test.testing": "正在测试连接...", "profiles.test.ping": "Ping。只回复 OK。", "profiles.test.success": "连接成功。", "profiles.test.error": "连接失败，请检查模型配置。",
    },
    "en": {
        "profiles.title": "Model profiles", "profiles.list": "Model profiles", "profiles.close": "Close",
        "profiles.status.autosave": "Changes save automatically", "profiles.status.saved": "Saved", "profiles.status.invalid": "Check this value and try again.",
        "profiles.section.basic": "Basic information", "profiles.section.connection": "Connection", "profiles.section.capabilities": "Capabilities", "profiles.section.generation": "Generation parameters", "profiles.section.local": "Local runtime",
        "profiles.id": "Profile ID", "profiles.display_name": "Display name", "profiles.model_id": "Model ID", "profiles.enabled": "Enabled", "profiles.disabled": "Disabled", "profiles.active": "Active model",
        "profiles.protocol": "API protocol", "profiles.protocol.gemini": "Gemini native", "profiles.protocol.openai": "OpenAI chat completions", "profiles.protocol.abbr.gemini": "GEM", "profiles.protocol.abbr.openai": "OAI",
        "profiles.runtime": "Runtime", "profiles.runtime.remote": "Remote HTTP", "profiles.runtime.endpoint": "llama.cpp endpoint", "profiles.runtime.once": "llama.cpp one-shot",
        "profiles.endpoint": "Endpoint", "profiles.fallback_endpoints": "Fallback endpoints (one per line)", "profiles.api_key": "API key", "profiles.api_key.show": "Show", "profiles.api_key.hide": "Hide",
        "profiles.capability.tools": "Tool calling", "profiles.capability.vision": "Vision input", "profiles.capability.streaming": "Streaming", "profiles.capability.reasoning": "Reasoning parameters",
        "profiles.temperature": "Temperature", "profiles.top_p": "Top P", "profiles.max_tokens": "Max tokens", "profiles.reasoning_effort": "Reasoning effort", "profiles.reasoning.low": "Low", "profiles.reasoning.high": "High", "profiles.reasoning.max": "Max", "profiles.timeout": "Timeout (seconds)",
        "profiles.teacher_mode": "Teacher redaction mode", "profiles.teacher_mode.qwen": "Local Qwen redaction", "profiles.teacher_mode.regex": "Placeholder redaction only", "profiles.sanitize_sensitive": "Sanitize sensitive content", "profiles.teacher_profile": "Teacher profile",
        "profiles.model_path": "GGUF path", "profiles.mmproj_path": "mmproj path", "profiles.llama_server_path": "llama-server path", "profiles.n_ctx": "Context size", "profiles.n_gpu_layers": "GPU layers", "profiles.thinking": "Thinking",
        "profiles.add": "Add", "profiles.duplicate": "Duplicate", "profiles.delete": "Delete", "profiles.set_active": "Set active", "profiles.restore": "Restore defaults", "profiles.new_name": "New model profile", "profiles.new_model_id": "model-id",
        "profiles.delete.confirm": "Delete this model profile?", "profiles.delete.last_enabled": "At least one enabled model profile is required.", "profiles.active.disabled": "Enable this profile before making it active.", "profiles.restore.confirm": "Replace all profiles with the defaults?",
        "profiles.test": "Test connection", "profiles.test.testing": "Testing connection...", "profiles.test.ping": "Ping. Reply with OK.", "profiles.test.success": "Connection successful.", "profiles.test.error": "Connection failed. Check the model profile.",
    },
}
for _locale, _messages in _PROFILE_TRANSLATIONS.items():
    TRANSLATIONS[_locale].update(_messages)


def normalize_locale(value: str | None) -> str:
    raw = str(value or "").strip().lower().replace("_", "-")
    if raw.startswith("en") or raw in {"english", "eng"}:
        return "en"
    if raw.startswith("zh") or raw in {"chinese", "cn", "中文", "简体中文"}:
        return "zh-CN"
    return DEFAULT_LOCALE


def forge_locale(value: str | None) -> str:
    raw = str(value or "").strip()
    if not raw or raw.lower() == "none":
        return "en"
    return normalize_locale(raw)


def current_locale() -> str:
    try:
        from modules import shared

        opts = getattr(shared, "opts", None)
        localization = getattr(opts, "localization", "") if opts else ""
        return forge_locale(localization)
    except Exception:
        return DEFAULT_LOCALE


def tr(key: str, locale: str | None = None, **kwargs: Any) -> str:
    selected = normalize_locale(locale) if locale else current_locale()
    text = TRANSLATIONS.get(selected, {}).get(key) or TRANSLATIONS[DEFAULT_LOCALE].get(key) or key
    return text.format(**kwargs) if kwargs else text


def translation_bundle(locale: str | None = None) -> dict[str, Any]:
    selected = normalize_locale(locale) if locale else current_locale()
    messages = dict(TRANSLATIONS[DEFAULT_LOCALE])
    messages.update(TRANSLATIONS.get(selected, {}))
    return {"locale": selected, "fallback_locale": DEFAULT_LOCALE, "messages": messages}
