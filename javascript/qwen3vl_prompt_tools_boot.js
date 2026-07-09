(function () {
    const tools = window.q3vlPromptTools;
    if (!tools) return;
    const {
        q3vlApp,
        q3vlMainApp,
        removeAssistantWindow,
        settingsPanel,
        setupQwenPresetGate,
        setupSendButtons,
        assistantState,
        DEEPSEEK_ASSISTANT_ENDPOINT,
        KNOWN_ASSISTANT_MODELS,
        MOYUU_ASSISTANT_FALLBACK_ENDPOINT,
        DEFAULT_QWEN_VISION_MODEL_PATH,
        DEFAULT_QWEN_VISION_MMPROJ_PATH,
        DEFAULT_LOCAL_CONTEXT_TOKENS,
        q3vlVisionPresets,
        storedAssistantEndpoint,
        storedAssistantModel,
        loadAssistantApiKey,
        normalizeAssistantMaxTokens,
        normalizeAssistantContextTokens,
        defaultVisionPreset,
        visionModelForPreset,
        defaultVisionModelPathForPreset,
        defaultVisionMmprojPathForPreset,
        defaultAssistantEndpointForBackend,
        defaultAssistantModelForBackend,
        setAssistantSettingsVisibility,
        syncAssistantBackendDefaults,
        saveAssistantConfig,
        storeAssistantApiKey,
        runAssistantLoop,
        setAssistantAttachment,
        renderAssistantAttachment,
        readAssistantImageFile,
        addAssistantMessage,
        tr
    } = tools;

    function t(key, fallback) {
        if (typeof tr !== "function") return fallback;
        const value = tr(key);
        return value && value !== key ? value : fallback;
    }

    function setupAssistantWindow() {
        if (!q3vlMainApp()) {
            removeAssistantWindow();
            return;
        }
        const existingLaunchers = document.querySelectorAll("#q3vl_assistant_launcher");
        const existingPanels = document.querySelectorAll("#q3vl_assistant_panel");
        if (existingLaunchers.length === 1 && existingPanels.length === 1) {
            setupAssistantSettingsWindow();
            return;
        }
        if (existingLaunchers.length || existingPanels.length) removeAssistantWindow();
        const launcher = document.createElement("button");
        launcher.id = "q3vl_assistant_launcher";
        launcher.type = "button";
        launcher.textContent = t("assistant.launcher", "LLM 助手");
        document.body.appendChild(launcher);
        restoreAssistantLauncherPosition(launcher);

        const panel = document.createElement("div");
        panel.id = "q3vl_assistant_panel";
        panel.innerHTML = `
            <div class="q3vl-assistant-head"><div><strong>${t("assistant.title", "LLM 提示词助手")}</strong></div><div class="q3vl-assistant-head-buttons"><button type="button" id="q3vl_assistant_close" class="q3vl-assistant-close" title="${t("assistant.close", "关闭")}" aria-label="${t("assistant.close", "关闭")}">×</button><button type="button" id="q3vl_assistant_settings_open" class="q3vl-assistant-icon-button" title="${t("assistant.settings", "设置")}" aria-label="${t("assistant.settings", "设置")}">⚙</button></div></div>
            <div id="q3vl_assistant_messages"></div>
            <div id="q3vl_assistant_attachment" class="q3vl-assistant-attachment q3vl-assistant-attachment-empty"></div>
            <div class="q3vl-assistant-composer">
                <textarea id="q3vl_assistant_input" placeholder="${t("assistant.input.placeholder", "例如：读取当前提示词，改成三名角色的自拍构图，明确左中右位置。Enter 换行，Ctrl+Enter 发送。")}"></textarea>
                <div class="q3vl-assistant-actions">
                    <div class="q3vl-assistant-action-group"><button type="button" id="q3vl_assistant_attach" class="q3vl-assistant-secondary">${t("assistant.attach", "附图")}</button><button type="button" id="q3vl_assistant_read" class="q3vl-assistant-secondary">${t("assistant.read", "读取")}</button></div>
                    <div class="q3vl-assistant-action-group"><button type="button" id="q3vl_assistant_clear" class="q3vl-assistant-ghost">${t("assistant.clear", "清空")}</button><button type="button" id="q3vl_assistant_send" class="q3vl-assistant-primary">${t("assistant.send", "发送")}</button></div>
                </div>
                <input id="q3vl_assistant_file" type="file" accept="image/*" hidden>
            </div>
        `;
        document.body.appendChild(panel);
        restoreAssistantPosition(panel);
        setupAssistantSettingsWindow();
        panel.querySelector("#q3vl_assistant_settings_open").addEventListener("click", function () {
            const configPanel = setupAssistantSettingsWindow();
            if (!configPanel) return;
            configPanel.classList.toggle("q3vl-settings-open");
        });
        launcher.addEventListener("click", function () {
            if (launcher.dataset.q3vlSuppressClick === "1") return;
            const open = panel.classList.toggle("q3vl-assistant-open");
            if (!open) settingsPanel()?.classList.remove("q3vl-settings-open");
        });
        panel.querySelector("#q3vl_assistant_close").addEventListener("click", function () {
            panel.classList.remove("q3vl-assistant-open");
            settingsPanel()?.classList.remove("q3vl-settings-open");
        });
        makeAssistantLauncherDraggable(launcher, panel);
        makeAssistantDraggable(panel, panel.querySelector(".q3vl-assistant-head"));
        panel.querySelector("#q3vl_assistant_send").addEventListener("click", function () {
            const input = panel.querySelector("#q3vl_assistant_input");
            const text = input.value.trim();
            const attachment = assistantState.attachment;
            if (!text && !attachment) return;
            input.value = "";
            setAssistantAttachment(null);
            runAssistantLoop(text, attachment);
        });
        const fileInput = panel.querySelector("#q3vl_assistant_file");
        panel.querySelector("#q3vl_assistant_attach").addEventListener("click", function () {
            fileInput.click();
        });
        fileInput.addEventListener("change", function () {
            const file = fileInput.files && fileInput.files[0];
            fileInput.value = "";
            readAssistantImageFile(file)
                .then(setAssistantAttachment)
                .catch(function (error) { addAssistantMessage("error", String(error.message || error)); });
        });
        panel.querySelector("#q3vl_assistant_input").addEventListener("keydown", function (event) {
            if (event.key !== "Enter") return;
            if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                panel.querySelector("#q3vl_assistant_send").click();
            } else {
                event.stopPropagation();
            }
        });
        panel.querySelector("#q3vl_assistant_read").addEventListener("click", function () {
            runAssistantLoop(t("assistant.read_prompt", "Read the current prompt and WebUI style template. Briefly summarize the composition, trigger words, and spatial relationships they describe. If both are empty, say they are empty."));
        });
        panel.querySelector("#q3vl_assistant_clear").addEventListener("click", function () {
            assistantState.messages = [];
            setAssistantAttachment(null);
            panel.querySelector("#q3vl_assistant_messages").textContent = "";
        });
        renderAssistantAttachment();
    }

    function setupAssistantSettingsWindow() {
        if (!q3vlMainApp()) {
            settingsPanel()?.remove();
            return null;
        }
        const existing = document.querySelectorAll("#q3vl_assistant_settings_panel");
        if (existing.length === 1) return existing[0];
        existing.forEach(function (el) { el.remove(); });

        const panel = document.createElement("div");
        panel.id = "q3vl_assistant_settings_panel";
        panel.innerHTML = `
            <div class="q3vl-settings-head"><div><strong>${t("settings.title", "助手设置")}</strong></div><button type="button" id="q3vl_settings_close" class="q3vl-assistant-close" title="${t("assistant.close", "关闭")}" aria-label="${t("assistant.close", "关闭")}">×</button></div>
            <div class="q3vl-settings-body">
                <nav class="q3vl-settings-nav" aria-label="${t("settings.primary_nav", "一级设置分类")}">
                    <button type="button" data-q3vl-settings-primary="route" class="q3vl-settings-nav-active">${t("settings.nav.route", "模型路由")}</button>
                    <button type="button" data-q3vl-settings-primary="remote">${t("settings.nav.remote", "远端模型")}</button>
                    <button type="button" data-q3vl-settings-primary="qwen">${t("settings.nav.local_qwen", "本地 Qwen")}</button>
                </nav>
                <nav class="q3vl-settings-subnav" aria-label="${t("settings.sub_nav", "二级设置分类")}">
                    <button type="button" data-q3vl-settings-page="route-main" data-q3vl-settings-parent="route" class="q3vl-settings-subnav-active">${t("settings.page.main", "主后端")}</button>
                    <button type="button" data-q3vl-settings-page="route-policy" data-q3vl-settings-parent="route">${t("settings.page.workflow", "工作流策略")}</button>
                    <button type="button" data-q3vl-settings-page="remote-preset" data-q3vl-settings-parent="remote">${t("settings.page.preset", "预设")}</button>
                    <button type="button" data-q3vl-settings-page="remote-endpoint" data-q3vl-settings-parent="remote">${t("settings.page.connection", "连接设置")}</button>
                    <button type="button" data-q3vl-settings-page="remote-params" data-q3vl-settings-parent="remote">${t("settings.page.params", "参数")}</button>
                    <button type="button" data-q3vl-settings-page="qwen-text" data-q3vl-settings-parent="qwen">${t("settings.page.text_model", "文本模型")}</button>
                    <button type="button" data-q3vl-settings-page="qwen-vision" data-q3vl-settings-parent="qwen">${t("settings.page.vision_model", "视觉模型")}</button>
                    <button type="button" data-q3vl-settings-page="qwen-paths" data-q3vl-settings-parent="qwen">${t("settings.page.vision_paths", "视觉路径")}</button>
                </nav>
                <div class="q3vl-settings-pages">
                    <section class="q3vl-settings-page q3vl-settings-page-active" data-q3vl-settings-page-panel="route-main">
                        <h3>${t("settings.page.main", "主后端")}</h3>
                        <div class="q3vl-settings-grid">
                            <label class="q3vl-settings-field q3vl-settings-field-wide"><span>${t("settings.backend", "后端")}</span><select data-q3vl-setting="backend"><option value="moyuu">Moyuu Gemini</option><option value="deepseek">DeepSeek</option><option value="local-qwen-once">${t("settings.backend.local_qwen_once", "本地 Qwen 一次性")}</option><option value="local-lmcpp">${t("settings.backend.local_endpoint", "本地接入点")}</option></select></label>
                        </div>
                    </section>
                    <section class="q3vl-settings-page" data-q3vl-settings-page-panel="route-policy">
                        <h3>${t("settings.page.workflow", "工作流策略")}</h3>
                        <div class="q3vl-settings-grid">
                            <label class="q3vl-settings-field" data-q3vl-field="remote" title="${t("settings.teacher_mode.title", "Gemini 教师前置脱敏策略")}"><span>${t("settings.teacher_mode", "教师策略")}</span><select data-q3vl-setting="teacher_mode"><option value="qwen-redact">${t("settings.teacher_mode.qwen_redact", "本地 Qwen 脱敏")}</option><option value="regex">${t("settings.teacher_mode.regex", "仅占位符脱敏")}</option></select></label>
                            <label class="q3vl-settings-field" data-q3vl-field="remote" title="${t("settings.sanitize.title", "发送到 Gemini 前把敏感提示词替换为占位符，返回工具参数时本地还原")}"><span>${t("settings.sanitize", "脱敏占位符")}</span><select data-q3vl-setting="sanitize_sensitive"><option value="1">${t("common.on", "开")}</option><option value="0">${t("common.off", "关")}</option></select></label>
                        </div>
                    </section>
                    <section class="q3vl-settings-page" data-q3vl-settings-page-panel="remote-preset">
                        <h3>${t("settings.remote_preset", "远端预设")}</h3>
                        <div class="q3vl-settings-grid">
                            <label class="q3vl-settings-field q3vl-settings-field-wide"><span>${t("settings.page.preset", "预设")}</span><select data-q3vl-setting="remote_preset"><option value="moyuu">Moyuu Gemini teacher</option><option value="deepseek">DeepSeek V4 Pro</option><option value="custom">${t("settings.preset.custom", "自定义")}</option></select></label>
                        </div>
                    </section>
                    <section class="q3vl-settings-page" data-q3vl-settings-page-panel="remote-endpoint">
                        <h3>${t("settings.page.connection", "连接设置")}</h3>
                        <div class="q3vl-settings-grid">
                            <label class="q3vl-settings-field" data-q3vl-field="remote"><span>${t("settings.page.endpoint", "接入点")}</span><input data-q3vl-setting="endpoint" placeholder="${t("settings.remote_endpoint.placeholder", "Moyuu/Gemini 接入点")}"></label>
                            <label class="q3vl-settings-field" data-q3vl-field="remote"><span>${t("settings.fallback_endpoint", "备用接入点")}</span><input data-q3vl-setting="fallback_endpoint" placeholder="${t("settings.fallback_endpoint.placeholder", "备用接入点")}"></label>
                            <label class="q3vl-settings-field" data-q3vl-field="remote"><span>${t("settings.model", "模型")}</span><input data-q3vl-setting="model" placeholder="${t("settings.model.placeholder", "Gemini 模型名称")}"></label>
                            <label class="q3vl-settings-field" data-q3vl-field="remote"><span>${t("settings.api_key", "API 密钥")}</span><input data-q3vl-setting="api_key" placeholder="${t("settings.api_key.placeholder", "API 密钥")}" type="password"></label>
                        </div>
                    </section>
                    <section class="q3vl-settings-page" data-q3vl-settings-page-panel="remote-params">
                        <h3>${t("settings.remote_params", "远端参数")}</h3>
                        <div class="q3vl-settings-grid">
                            <label class="q3vl-settings-field" data-q3vl-field="remote"><span>${t("settings.reasoning_effort", "推理强度")}</span><select data-q3vl-setting="reasoning_effort"><option value="high">${t("settings.reasoning_high", "高")}</option><option value="max">${t("settings.reasoning_max", "最大")}</option></select></label>
                            <label class="q3vl-settings-field" data-q3vl-field="remote"><span>${t("settings.max_tokens", "最大 token 数")}</span><input data-q3vl-setting="max_tokens" placeholder="8192"></label>
                        </div>
                    </section>
                    <section class="q3vl-settings-page" data-q3vl-settings-page-panel="qwen-text">
                        <h3>${t("settings.qwen_text", "本地文本模型")}</h3>
                        <div class="q3vl-settings-grid">
                            <label class="q3vl-settings-field" data-q3vl-field="local-text"><span>${t("settings.local_endpoint", "文本接入点")}</span><input data-q3vl-setting="local_endpoint" placeholder="http://127.0.0.1:8080/v1"></label>
                            <label class="q3vl-settings-field" data-q3vl-field="local-text"><span>${t("settings.local_model", "文本模型名称")}</span><input data-q3vl-setting="local_model" placeholder="hauhau-qwen3.5-9b-uncensored"></label>
                            <label class="q3vl-settings-field q3vl-settings-field-wide"><span>${t("settings.n_ctx", "上下文长度 n_ctx")}</span><input data-q3vl-setting="n_ctx" placeholder="16384"></label>
                        </div>
                    </section>
                    <section class="q3vl-settings-page" data-q3vl-settings-page-panel="qwen-vision">
                        <h3>${t("settings.qwen_vision", "本地视觉模型")}</h3>
                        <div class="q3vl-settings-grid">
                            <label class="q3vl-settings-field" data-q3vl-field="local-vision"><span>${t("settings.vision_preset", "视觉预设")}</span><select data-q3vl-setting="vision_preset"><option value="Gemma 4 12B">Gemma 4 12B</option><option value="Qwen3.5 原版 9B">Qwen3.5 原版 9B</option><option value="Qwen3.5 破限版 9B">Qwen3.5 破限版 9B</option><option value="自定义">${t("settings.preset.custom", "自定义")}</option></select></label>
                            <label class="q3vl-settings-field" data-q3vl-field="local-vision"><span>${t("settings.vision_thinking", "视觉推理")}</span><select data-q3vl-setting="vision_thinking"><option value="0">${t("common.off", "关")}</option><option value="1">${t("common.on", "开")}</option></select></label>
                        </div>
                    </section>
                    <section class="q3vl-settings-page" data-q3vl-settings-page-panel="qwen-paths">
                        <h3>${t("settings.page.vision_paths", "视觉模型路径")}</h3>
                        <div class="q3vl-settings-grid">
                            <label class="q3vl-settings-field q3vl-settings-field-wide" data-q3vl-field="vision-advanced"><span>${t("settings.vision_endpoint", "视觉接入点")}</span><input data-q3vl-setting="vision_endpoint" placeholder="http://127.0.0.1:8080/v1"></label>
                            <label class="q3vl-settings-field q3vl-settings-field-wide" data-q3vl-field="vision-advanced"><span>${t("settings.vision_model", "模型别名")}</span><input data-q3vl-setting="vision_model" placeholder="hauhau-qwen3.5-9b-uncensored"></label>
                            <label class="q3vl-settings-field q3vl-settings-field-wide" data-q3vl-field="vision-custom"><span>${t("settings.vision_model_path", "Qwen 视觉 GGUF 路径")}</span><input data-q3vl-setting="vision_model_path" placeholder="${t("settings.vision_model_path.placeholder", "视觉模型 GGUF 路径")}"></label>
                            <label class="q3vl-settings-field q3vl-settings-field-wide" data-q3vl-field="vision-custom"><span>${t("settings.vision_mmproj_path", "Qwen mmproj 路径")}</span><input data-q3vl-setting="vision_mmproj_path" placeholder="${t("settings.vision_mmproj_path.placeholder", "对应 mmproj GGUF 路径")}"></label>
                        </div>
                    </section>
                </div>
            </div>
        `;
        document.body.appendChild(panel);
        restoreAssistantPosition(panel, "q3vl_settings_position");
        setupAssistantSettingsNavigation(panel);

        const backend = panel.querySelector('[data-q3vl-setting="backend"]');
        const storedBackend = localStorage.getItem("q3vl_assistant_backend");
        const storedEndpointValue = localStorage.getItem("q3vl_assistant_endpoint");
        const storedModelValue = localStorage.getItem("q3vl_assistant_model");
        const migrateDeepSeekDefault = storedBackend === "deepseek" && (!storedEndpointValue || storedEndpointValue === DEEPSEEK_ASSISTANT_ENDPOINT) && (!storedModelValue || KNOWN_ASSISTANT_MODELS.includes(storedModelValue));
        backend.value = migrateDeepSeekDefault ? "moyuu" : storedBackend || "moyuu";
        const endpointInput = panel.querySelector('[data-q3vl-setting="endpoint"]');
        const fallbackInput = panel.querySelector('[data-q3vl-setting="fallback_endpoint"]');
        const modelInput = panel.querySelector('[data-q3vl-setting="model"]');
        endpointInput.value = storedAssistantEndpoint();
        fallbackInput.value = localStorage.getItem("q3vl_assistant_fallback_endpoint") || MOYUU_ASSISTANT_FALLBACK_ENDPOINT;
        modelInput.value = storedAssistantModel(endpointInput.value);
        if (modelInput.value !== localStorage.getItem("q3vl_assistant_model")) {
            localStorage.setItem("q3vl_assistant_model", modelInput.value);
        }
        const remotePreset = panel.querySelector('[data-q3vl-setting="remote_preset"]');
        remotePreset.value = localStorage.getItem("q3vl_assistant_remote_preset") || remotePresetFromSettings(backend.value, endpointInput.value, modelInput.value);
        loadAssistantApiKey(panel, backend.value);
        panel.querySelector('[data-q3vl-setting="max_tokens"]').value = String(normalizeAssistantMaxTokens(localStorage.getItem("q3vl_assistant_max_tokens") || "8192"));
        panel.querySelector('[data-q3vl-setting="n_ctx"]').value = String(normalizeAssistantContextTokens(localStorage.getItem("q3vl_assistant_n_ctx") || String(DEFAULT_LOCAL_CONTEXT_TOKENS)));
        panel.querySelector('[data-q3vl-setting="sanitize_sensitive"]').value = localStorage.getItem("q3vl_assistant_sanitize_sensitive") || "1";
        panel.querySelector('[data-q3vl-setting="teacher_mode"]').value = localStorage.getItem("q3vl_assistant_teacher_mode") || "qwen-redact";
        panel.querySelector('[data-q3vl-setting="reasoning_effort"]').value = localStorage.getItem("q3vl_assistant_reasoning_effort") || "high";
        panel.querySelector('[data-q3vl-setting="local_endpoint"]').value = localStorage.getItem("q3vl_assistant_local_endpoint") || "http://127.0.0.1:8080/v1";
        panel.querySelector('[data-q3vl-setting="local_model"]').value = localStorage.getItem("q3vl_assistant_local_model") || "hauhau-qwen3.5-9b-uncensored";
        const visionPreset = panel.querySelector('[data-q3vl-setting="vision_preset"]');
        const visionModel = panel.querySelector('[data-q3vl-setting="vision_model"]');
        const visionModelPath = panel.querySelector('[data-q3vl-setting="vision_model_path"]');
        const visionMmprojPath = panel.querySelector('[data-q3vl-setting="vision_mmproj_path"]');
        visionPreset.value = localStorage.getItem("q3vl_assistant_vision_preset") || defaultVisionPreset();
        panel.querySelector('[data-q3vl-setting="vision_thinking"]').value = localStorage.getItem("q3vl_assistant_vision_thinking") || "0";
        panel.querySelector('[data-q3vl-setting="vision_endpoint"]').value = localStorage.getItem("q3vl_assistant_vision_endpoint") || "http://127.0.0.1:8080/v1";
        visionModel.value = localStorage.getItem("q3vl_assistant_vision_model") || visionModelForPreset(visionPreset.value);
        visionModelPath.value = localStorage.getItem("q3vl_assistant_vision_model_path") || defaultVisionModelPathForPreset(visionPreset.value);
        visionMmprojPath.value = localStorage.getItem("q3vl_assistant_vision_mmproj_path") || defaultVisionMmprojPathForPreset(visionPreset.value);
        syncVisionPresetDefaults(visionPreset, visionModel, visionModelPath, visionMmprojPath);
        visionPreset.addEventListener("change", function () {
            syncVisionPresetDefaults(visionPreset, visionModel, visionModelPath, visionMmprojPath);
            saveAssistantConfig();
            setAssistantSettingsVisibility(panel);
        });
        remotePreset.addEventListener("change", function () {
            applyRemotePreset(panel, true);
            saveAssistantConfig();
            setAssistantSettingsVisibility(panel);
        });
        panel.querySelectorAll("[data-q3vl-setting]").forEach(function (input) {
            input.addEventListener("change", saveAssistantConfig);
            input.addEventListener("input", saveAssistantConfig);
            input.addEventListener("change", function () { setAssistantSettingsVisibility(panel); });
        });
        backend.addEventListener("change", function () {
            storeAssistantApiKey(panel, assistantState.apiKeyBackend);
            loadAssistantApiKey(panel, backend.value);
            syncAssistantBackendDefaults(panel);
            syncRemotePresetFromBackend(panel);
            saveAssistantConfig();
            setAssistantSettingsVisibility(panel);
        });
        panel.querySelector("#q3vl_settings_close").addEventListener("click", function () {
            panel.classList.remove("q3vl-settings-open");
        });
        makeAssistantDraggable(panel, panel.querySelector(".q3vl-settings-head"), "q3vl_settings_position");
        syncAssistantBackendDefaults(panel);
        saveAssistantConfig();
        setAssistantSettingsVisibility(panel);
        return panel;
    }

    function setupAssistantSettingsNavigation(panel) {
        const savedPage = localStorage.getItem("q3vl_settings_page") || "route-main";
        activateAssistantSettingsPage(panel, parentForSettingsPage(panel, savedPage), savedPage);
        panel.querySelectorAll("[data-q3vl-settings-primary]").forEach(function (button) {
            button.addEventListener("click", function () {
                const primary = button.dataset.q3vlSettingsPrimary || "route";
                const page = firstSettingsPageForPrimary(panel, primary);
                localStorage.setItem("q3vl_settings_primary", primary);
                localStorage.setItem("q3vl_settings_page", page);
                activateAssistantSettingsPage(panel, primary, page);
            });
        });
        panel.querySelectorAll("[data-q3vl-settings-page]").forEach(function (button) {
            button.addEventListener("click", function () {
                const page = button.dataset.q3vlSettingsPage || "text";
                const primary = button.dataset.q3vlSettingsParent || parentForSettingsPage(panel, page);
                localStorage.setItem("q3vl_settings_primary", primary);
                localStorage.setItem("q3vl_settings_page", page);
                activateAssistantSettingsPage(panel, primary, page);
            });
        });
    }

    function activateAssistantSettingsPage(panel, primary, page) {
        const activePrimary = panel.querySelector(`[data-q3vl-settings-primary="${primary}"]`) ? primary : "route";
        let target = panel.querySelector(`[data-q3vl-settings-page-panel="${page}"]`) ? page : firstSettingsPageForPrimary(panel, activePrimary);
        if (parentForSettingsPage(panel, target) !== activePrimary) target = firstSettingsPageForPrimary(panel, activePrimary);
        panel.querySelectorAll("[data-q3vl-settings-primary]").forEach(function (button) {
            button.classList.toggle("q3vl-settings-nav-active", button.dataset.q3vlSettingsPrimary === activePrimary);
        });
        panel.querySelectorAll("[data-q3vl-settings-page]").forEach(function (button) {
            const visible = button.dataset.q3vlSettingsParent === activePrimary;
            button.hidden = !visible;
            button.classList.toggle("q3vl-settings-subnav-active", visible && button.dataset.q3vlSettingsPage === target);
        });
        panel.querySelectorAll("[data-q3vl-settings-page-panel]").forEach(function (section) {
            section.classList.toggle("q3vl-settings-page-active", section.dataset.q3vlSettingsPagePanel === target);
        });
    }

    function firstSettingsPageForPrimary(panel, primary) {
        return panel.querySelector(`[data-q3vl-settings-parent="${primary}"]`)?.dataset.q3vlSettingsPage || "route-main";
    }

    function parentForSettingsPage(panel, page) {
        return panel.querySelector(`[data-q3vl-settings-page="${page}"]`)?.dataset.q3vlSettingsParent || "route";
    }

    function remotePresetFromSettings(backend, endpoint, model) {
        const deepseekDefault = endpoint === DEEPSEEK_ASSISTANT_ENDPOINT && model === defaultAssistantModelForBackend("deepseek");
        const moyuuDefault = endpoint === defaultAssistantEndpointForBackend("moyuu") && model === defaultAssistantModelForBackend("moyuu");
        if (deepseekDefault && (!backend || backend === "deepseek")) return "deepseek";
        if (moyuuDefault && (!backend || backend === "moyuu")) return "moyuu";
        return "custom";
    }

    function applyRemotePreset(panel, updateBackend) {
        const preset = panel.querySelector('[data-q3vl-setting="remote_preset"]')?.value || "moyuu";
        if (preset === "custom") return;
        const backend = panel.querySelector('[data-q3vl-setting="backend"]');
        const endpoint = panel.querySelector('[data-q3vl-setting="endpoint"]');
        const model = panel.querySelector('[data-q3vl-setting="model"]');
        if (updateBackend && backend) {
            storeAssistantApiKey(panel, assistantState.apiKeyBackend);
            backend.value = preset;
            loadAssistantApiKey(panel, backend.value);
        }
        if (endpoint) endpoint.value = defaultAssistantEndpointForBackend(preset);
        if (model) model.value = defaultAssistantModelForBackend(preset);
    }

    function syncRemotePresetFromBackend(panel) {
        const backend = panel.querySelector('[data-q3vl-setting="backend"]')?.value || "moyuu";
        const remotePreset = panel.querySelector('[data-q3vl-setting="remote_preset"]');
        if (remotePreset && (backend === "moyuu" || backend === "deepseek")) remotePreset.value = backend;
    }

    function syncVisionPresetDefaults(presetInput, modelInput, modelPathInput, mmprojPathInput) {
        const preset = presetInput.value || defaultVisionPreset();
        if (!modelInput.value || Object.values(q3vlVisionPresets).includes(modelInput.value)) {
            modelInput.value = visionModelForPreset(preset);
        }
        if (!modelPathInput.value || modelPathInput.value === DEFAULT_QWEN_VISION_MODEL_PATH) {
            modelPathInput.value = defaultVisionModelPathForPreset(preset);
        }
        if (!mmprojPathInput.value || mmprojPathInput.value === DEFAULT_QWEN_VISION_MMPROJ_PATH) {
            mmprojPathInput.value = defaultVisionMmprojPathForPreset(preset);
        }
    }

    function restoreAssistantLauncherPosition(launcher) {
        const raw = localStorage.getItem("q3vl_assistant_launcher_position");
        if (!raw) return;
        try {
            const pos = JSON.parse(raw);
            if (Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
                launcher.style.left = `${Math.max(8, Math.min(pos.left, window.innerWidth - 96))}px`;
                launcher.style.top = `${Math.max(8, Math.min(pos.top, window.innerHeight - 48))}px`;
                launcher.style.right = "auto";
                launcher.style.bottom = "auto";
            }
        } catch (_error) { }
    }

    function makeAssistantLauncherDraggable(launcher, panel) {
        if (!launcher || launcher.dataset.q3vlDragBound) return;
        launcher.dataset.q3vlDragBound = "1";
        let pointerDown = false;
        let moved = false;
        let startX = 0;
        let startY = 0;
        let startLeft = 0;
        let startTop = 0;

        launcher.addEventListener("pointerdown", function (event) {
            const rect = launcher.getBoundingClientRect();
            pointerDown = true;
            moved = false;
            startX = event.clientX;
            startY = event.clientY;
            startLeft = rect.left;
            startTop = rect.top;
            launcher.style.left = `${rect.left}px`;
            launcher.style.top = `${rect.top}px`;
            launcher.style.right = "auto";
            launcher.style.bottom = "auto";
            launcher.setPointerCapture?.(event.pointerId);
        });

        launcher.addEventListener("pointermove", function (event) {
            if (!pointerDown) return;
            const deltaX = event.clientX - startX;
            const deltaY = event.clientY - startY;
            if (!moved && Math.hypot(deltaX, deltaY) < 4) return;
            moved = true;
            const left = Math.max(8, Math.min(startLeft + deltaX, window.innerWidth - launcher.offsetWidth - 8));
            const top = Math.max(8, Math.min(startTop + deltaY, window.innerHeight - launcher.offsetHeight - 8));
            launcher.style.left = `${left}px`;
            launcher.style.top = `${top}px`;
            event.preventDefault();
        });

        launcher.addEventListener("pointerup", function () {
            if (!pointerDown) return;
            pointerDown = false;
            if (!moved) return;
            const rect = launcher.getBoundingClientRect();
            localStorage.setItem("q3vl_assistant_launcher_position", JSON.stringify({ left: rect.left, top: rect.top }));
            launcher.dataset.q3vlSuppressClick = "1";
            setTimeout(function () { delete launcher.dataset.q3vlSuppressClick; }, 0);
        });
    }

    function restoreAssistantPosition(panel, storageKey) {
        const raw = localStorage.getItem(storageKey || "q3vl_assistant_position");
        if (!raw) return;
        try {
            const pos = JSON.parse(raw);
            if (Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
                const fallbackWidth = Math.min(panel.id === "q3vl_assistant_settings_panel" ? 900 : 480, window.innerWidth - 16);
                const fallbackHeight = Math.min(panel.id === "q3vl_assistant_settings_panel" ? 680 : 680, window.innerHeight - 16);
                const width = panel.offsetWidth || fallbackWidth;
                const height = panel.offsetHeight || fallbackHeight;
                panel.style.left = `${Math.max(8, Math.min(pos.left, window.innerWidth - width - 8))}px`;
                panel.style.top = `${Math.max(8, Math.min(pos.top, window.innerHeight - height - 8))}px`;
                panel.style.right = "auto";
                panel.style.bottom = "auto";
            }
        } catch (_error) { }
    }

    function makeAssistantDraggable(panel, handle, storageKey) {
        if (!panel || !handle || handle.dataset.q3vlDragBound) return;
        handle.dataset.q3vlDragBound = "1";
        const positionKey = storageKey || "q3vl_assistant_position";
        let dragging = false;
        let activePointerId = null;
        let startX = 0;
        let startY = 0;
        let startLeft = 0;
        let startTop = 0;

        function pointerDown(event) {
            if (event.button !== undefined && event.button !== 0) return;
            if (event.target && event.target.closest("button, input, textarea, select, a, [role='button']")) return;
            const rect = panel.getBoundingClientRect();
            dragging = true;
            activePointerId = event.pointerId;
            startX = event.clientX;
            startY = event.clientY;
            startLeft = rect.left;
            startTop = rect.top;
            panel.style.left = `${rect.left}px`;
            panel.style.top = `${rect.top}px`;
            panel.style.right = "auto";
            panel.style.bottom = "auto";
            panel.classList.add("q3vl-floating-dragging");
            handle.setPointerCapture?.(event.pointerId);
            event.preventDefault();
        }

        function pointerMove(event) {
            if (!dragging) return;
            if (activePointerId !== null && event.pointerId !== activePointerId) return;
            const left = Math.max(8, Math.min(startLeft + event.clientX - startX, window.innerWidth - panel.offsetWidth - 8));
            const top = Math.max(8, Math.min(startTop + event.clientY - startY, window.innerHeight - panel.offsetHeight - 8));
            panel.style.left = `${left}px`;
            panel.style.top = `${top}px`;
            event.preventDefault();
        }

        function pointerUp(event) {
            if (!dragging) return;
            if (activePointerId !== null && event.pointerId !== undefined && event.pointerId !== activePointerId) return;
            dragging = false;
            activePointerId = null;
            panel.classList.remove("q3vl-floating-dragging");
            const rect = panel.getBoundingClientRect();
            localStorage.setItem(positionKey, JSON.stringify({ left: rect.left, top: rect.top }));
        }

        handle.addEventListener("pointerdown", pointerDown);
        window.addEventListener("pointermove", pointerMove);
        window.addEventListener("pointerup", pointerUp);
        window.addEventListener("pointercancel", pointerUp);
    }

    function isMobileViewport() {
        return window.matchMedia("(max-width: 720px), (pointer: coarse)").matches;
    }

    function isVisibleElement(element) {
        return !!(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
    }

    function generationPageVisible() {
        const app = q3vlApp();
        return ["#txt2img_prompt", "#txt2img_settings", "#img2img_prompt", "#img2img_settings"].some(function (selector) {
            return isVisibleElement(app.querySelector(selector));
        });
    }

    function pullRefreshGuardActive() {
        return !!q3vlMainApp() && isMobileViewport() && generationPageVisible();
    }

    function nearestScrollableElement(node) {
        let current = node instanceof Element ? node : node?.parentElement;
        while (current && current !== document.body && current !== document.documentElement) {
            const style = window.getComputedStyle(current);
            if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight + 1) return current;
            current = current.parentElement;
        }
        return document.scrollingElement || document.documentElement;
    }

    function setupPullRefreshGuard() {
        document.documentElement.classList.toggle("q3vl-no-pull-refresh", pullRefreshGuardActive());
        if (document.documentElement.dataset.q3vlPullRefreshBound === "1") return;
        document.documentElement.dataset.q3vlPullRefreshBound = "1";

        let startX = 0;
        let startY = 0;
        document.addEventListener("touchstart", function (event) {
            if (!event.touches || !event.touches.length) return;
            startX = event.touches[0].clientX;
            startY = event.touches[0].clientY;
        }, { passive: true, capture: true });
        document.addEventListener("touchmove", function (event) {
            if (!pullRefreshGuardActive() || !event.touches || !event.touches.length) return;
            const dx = event.touches[0].clientX - startX;
            const dy = event.touches[0].clientY - startY;
            if (dy <= 0 || Math.abs(dx) > dy) return;
            const scrollable = nearestScrollableElement(event.target);
            const page = document.scrollingElement || document.documentElement;
            if (scrollable.scrollTop > 0 || (scrollable === page && page.scrollTop > 0)) return;
            event.preventDefault();
        }, { passive: false, capture: true });
        window.addEventListener("resize", setupPullRefreshGuard);
    }

    function setupQwenTools() {
        if (typeof tools.loadI18nBundle === "function" && !tools.q3vlI18nReady) {
            if (!tools.q3vlI18nSetupWaiting) {
                tools.q3vlI18nSetupWaiting = true;
                tools.loadI18nBundle().finally(function () {
                    tools.q3vlI18nSetupWaiting = false;
                    setupQwenTools();
                });
            }
            return;
        }
        if (!q3vlMainApp()) {
            removeAssistantWindow();
            setupPullRefreshGuard();
            return;
        }
        setupQwenPresetGate();
        setupSendButtons();
        setupAssistantWindow();
        setupPullRefreshGuard();
    }

    if (typeof onUiLoaded === "function") {
        onUiLoaded(setupQwenTools);
    } else {
        window.addEventListener("load", setupQwenTools);
    }

    if (typeof onAfterUiUpdate === "function") {
        onAfterUiUpdate(setupQwenTools);
    } else {
        window.setInterval(setupQwenTools, 1500);
    }
})();
