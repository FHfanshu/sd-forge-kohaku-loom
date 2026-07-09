(function () {
    const tools = window.q3vlPromptTools = window.q3vlPromptTools || {};

    const DEFAULT_LOCALE = "zh-CN";
    const messages = {
        "zh-CN": {
            "assistant.attach": "附图",
            "assistant.clear": "清空",
            "assistant.close": "关闭",
            "assistant.input.placeholder": "例如：读取当前提示词，改成三名角色的自拍构图，明确左中右位置。Enter 换行，Ctrl+Enter 发送。",
            "assistant.launcher": "LLM 助手",
            "assistant.read": "读取",
            "assistant.read_prompt": "Read the current prompt and WebUI style template. Briefly summarize the composition, trigger words, and spatial relationships they describe. If both are empty, say they are empty.",
            "assistant.rewind": "编辑并重新发送",
            "assistant.send": "发送",
            "assistant.settings": "设置",
            "assistant.stop": "终止",
            "assistant.title": "LLM 提示词助手",
            "common.off": "关",
            "common.on": "开",
            "inline.disabled_hint": "Qwen3-VL 扩写仅在 UI Preset = krea 时可用",
            "inline.sent": "已发送",
            "settings.api_key": "API 密钥",
            "settings.api_key.placeholder": "API 密钥",
            "settings.backend": "后端",
            "settings.backend.local_endpoint": "本地接入点",
            "settings.backend.local_qwen_once": "本地模型一次性",
            "settings.fallback_endpoint": "备用接入点",
            "settings.fallback_endpoint.placeholder": "备用接入点",
            "settings.local_endpoint": "文本接入点",
            "settings.local_agent_params": "本地代理参数",
            "settings.local_max_tokens": "本地最大 token 数",
            "settings.local_model": "文本模型名称",
            "settings.local_model_preset": "模型预设",
            "settings.local_no_api_key": "本地后端无需 API key",
            "settings.local_shared_model": "本地共享多模态模型",
            "settings.local_text_thinking": "文本推理",
            "settings.main_backend": "主后端",
            "settings.max_tokens": "最大 token 数",
            "settings.model": "模型",
            "settings.model.placeholder": "Gemini 模型名称",
            "settings.nav.local_qwen": "本地模型",
            "settings.nav.remote": "远端模型",
            "settings.nav.route": "模型路由",
            "settings.n_ctx": "上下文长度 n_ctx",
            "settings.page.connection": "连接设置",
            "settings.page.endpoint": "接入点",
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
            "settings.reasoning_high": "高",
            "settings.reasoning_max": "最大",
            "settings.remote_endpoint": "远端接入点",
            "settings.remote_endpoint.placeholder": "OpenAI-compatible Base URL",
            "settings.remote_preset": "远端预设",
            "settings.remote_params": "远端参数",
            "settings.sanitize": "脱敏占位符",
            "settings.sanitize.title": "发送到 Gemini 前把敏感提示词替换为占位符，返回工具参数时本地还原",
            "settings.teacher_mode": "教师策略",
            "settings.teacher_mode.title": "Gemini 教师前置脱敏策略",
            "settings.teacher_mode.qwen_redact": "本地模型脱敏",
            "settings.teacher_mode.regex": "仅占位符脱敏",
            "settings.workflow_preset": "工作流预设",
            "settings.workflow.gemini_main_local_filter": "Gemini 3.1 Pro 主力 + 本地 Gemma 脱敏",
            "settings.workflow.local_executor_gemini_adviser": "本地 Gemma 工具执行 + Gemini adviser",
            "settings.title": "助手设置",
            "settings.vision_endpoint": "视觉接入点",
            "settings.vision_model": "模型别名",
            "settings.vision_model_path": "模型 GGUF 路径",
            "settings.vision_model_path.placeholder": "视觉模型 GGUF 路径",
            "settings.vision_mmproj_path": "mmproj 路径",
            "settings.vision_mmproj_path.placeholder": "对应 mmproj GGUF 路径",
            "settings.vision_preset": "视觉预设",
            "settings.vision_thinking": "视觉推理",
            "settings.qwen_text": "本地模型文本",
            "settings.qwen_vision": "本地模型视觉"
        },
        en: {
            "assistant.attach": "Attach image",
            "assistant.clear": "Clear",
            "assistant.close": "Close",
            "assistant.input.placeholder": "Example: read the current prompt and turn it into a three-character selfie composition with clear left, center, and right positions. Enter for newline, Ctrl+Enter to send.",
            "assistant.launcher": "LLM Assistant",
            "assistant.read": "Read",
            "assistant.read_prompt": "Read the current prompt and WebUI style template. Briefly summarize the composition, trigger words, and spatial relationships they describe. If both are empty, say they are empty.",
            "assistant.rewind": "Edit and resend",
            "assistant.send": "Send",
            "assistant.settings": "Settings",
            "assistant.stop": "Stop",
            "assistant.title": "LLM Prompt Assistant",
            "common.off": "Off",
            "common.on": "On",
            "inline.disabled_hint": "Qwen3-VL expansion is only available when UI Preset = krea",
            "inline.sent": "Sent",
            "settings.api_key": "API key",
            "settings.api_key.placeholder": "API key",
            "settings.backend": "Backend",
            "settings.backend.local_endpoint": "Local endpoint",
            "settings.backend.local_qwen_once": "Local model one-shot",
            "settings.fallback_endpoint": "Fallback endpoint",
            "settings.fallback_endpoint.placeholder": "Fallback endpoint",
            "settings.local_endpoint": "Text endpoint",
            "settings.local_agent_params": "Local Agent Parameters",
            "settings.local_max_tokens": "Local max tokens",
            "settings.local_model": "Text model name",
            "settings.local_model_preset": "Model preset",
            "settings.local_no_api_key": "Local backends do not need an API key",
            "settings.local_shared_model": "Local Shared Multimodal Model",
            "settings.local_text_thinking": "Text thinking",
            "settings.main_backend": "Main Backend",
            "settings.max_tokens": "Max tokens",
            "settings.model": "Model",
            "settings.model.placeholder": "Gemini model name",
            "settings.nav.local_qwen": "Local Model",
            "settings.nav.remote": "Remote Models",
            "settings.nav.route": "Model Route",
            "settings.n_ctx": "Context length n_ctx",
            "settings.page.connection": "Connection Settings",
            "settings.page.endpoint": "Endpoint",
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
            "settings.reasoning_high": "High",
            "settings.reasoning_max": "Max",
            "settings.remote_endpoint": "Remote Endpoint",
            "settings.remote_endpoint.placeholder": "OpenAI-compatible Base URL",
            "settings.remote_preset": "Remote Preset",
            "settings.remote_params": "Remote Parameters",
            "settings.sanitize": "Sanitize placeholders",
            "settings.sanitize.title": "Replace sensitive prompt text with placeholders before sending to Gemini, then restore tool arguments locally",
            "settings.teacher_mode": "Teacher policy",
            "settings.teacher_mode.title": "Gemini teacher pre-redaction policy",
            "settings.teacher_mode.qwen_redact": "Local model redaction",
            "settings.teacher_mode.regex": "Placeholder redaction only",
            "settings.workflow_preset": "Workflow preset",
            "settings.workflow.gemini_main_local_filter": "Gemini 3.1 Pro main + local Gemma redaction",
            "settings.workflow.local_executor_gemini_adviser": "Local Gemma tool executor + Gemini adviser",
            "settings.title": "Assistant Settings",
            "settings.vision_endpoint": "Vision endpoint",
            "settings.vision_model": "Model alias",
            "settings.vision_model_path": "Model GGUF path",
            "settings.vision_model_path.placeholder": "Vision model GGUF path",
            "settings.vision_mmproj_path": "mmproj path",
            "settings.vision_mmproj_path.placeholder": "Matching mmproj GGUF path",
            "settings.vision_preset": "Vision preset",
            "settings.vision_thinking": "Vision thinking",
            "settings.qwen_text": "Local Model Text",
            "settings.qwen_vision": "Local Model Vision"
        }
    };
    let activeLocale = DEFAULT_LOCALE;

    function normalizeLocale(value) {
        const raw = String(value || "").trim().toLowerCase().replace("_", "-");
        if (raw.startsWith("en") || raw === "english") return "en";
        if (raw.startsWith("zh") || raw === "cn" || raw === "中文") return "zh-CN";
        return DEFAULT_LOCALE;
    }

    function currentLocale() {
        return activeLocale;
    }

    function tr(key) {
        const locale = currentLocale();
        return (messages[locale] && messages[locale][key]) || messages[DEFAULT_LOCALE][key] || key;
    }

    function loadI18nBundle() {
        if (tools.q3vlI18nLoading) return tools.q3vlI18nLoading;
        tools.q3vlI18nLoading = fetch("/qwen3vl-prompt-tools/i18n")
            .then(function (response) { return response.ok ? response.json() : null; })
            .then(function (bundle) {
                if (!bundle || !bundle.messages) return;
                const locale = normalizeLocale(bundle.locale);
                messages[locale] = Object.assign({}, messages[DEFAULT_LOCALE], bundle.messages);
                activeLocale = locale;
                tools.q3vlActiveLocale = locale;
            })
            .catch(function () { })
            .finally(function () { tools.q3vlI18nReady = true; });
        return tools.q3vlI18nLoading;
    }

    Object.assign(tools, {
        q3vlMessages: messages,
        q3vlLocale: currentLocale,
        tr,
        loadI18nBundle
    });

    loadI18nBundle();
})();
