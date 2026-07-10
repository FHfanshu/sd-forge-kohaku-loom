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
        assistantConfig,
        runAssistantLoop,
        cancelAssistantRun,
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

    const assistantIcons = {
        attach: '<path d="M20.5 11.5 12 20a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.6l-9 9a2 2 0 0 1-2.8-2.8l8.3-8.3"/>',
        read: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5zM20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5z"/>',
        clear: '<path d="M4 7h16M9 3h6l1 4H8zM7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
        send: '<path d="m3 11 18-8-8 18-2-8zM11 13 21 3"/>',
        stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
        model: '<path d="m12 3 1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6zM18.5 16l.8 2.7 2.7.8-2.7.8-.8 2.7-.8-2.7-2.7-.8 2.7-.8z"/>',
        chevron: '<path d="m8 10 4 4 4-4"/>',
        reasoning: '<rect class="q3vl-effort-low" x="4" y="14" width="3" height="6" rx="1"/><rect class="q3vl-effort-high" x="10.5" y="9" width="3" height="11" rx="1"/><rect class="q3vl-effort-max" x="17" y="4" width="3" height="16" rx="1"/>'
    };

    function assistantIcon(name) {
        return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${assistantIcons[name] || ""}</svg>`;
    }

    function resizeAssistantInput(input) {
        if (!input) return;
        input.style.height = "auto";
        input.style.height = `${Math.min(Math.max(input.scrollHeight, 58), 168)}px`;
    }

    function syncAssistantRouteLabel() {
        const config = assistantConfig("primary");
        const selector = document.querySelector("#q3vl_assistant_model");
        if (selector) {
            const route = localStorage.getItem("q3vl_assistant_chat_model_route") || "primary";
            const models = [["primary", config.model], ["fallback", config.fallback_model], ["local", config.vision_preset]];
            const selected = models.find(function ([value]) { return value === route; }) || models[0];
            selector.dataset.q3vlRoute = selected[0];
            selector.querySelector(".q3vl-assistant-model-name").textContent = selected[1];
            selector.title = `${t("settings.model", "模型")}: ${selected[1]}`;
            const menu = document.querySelector("#q3vl_assistant_model_menu");
            if (menu) menu.replaceChildren(...models.map(function ([value, label]) {
                const option = document.createElement("button");
                option.type = "button";
                option.dataset.q3vlRoute = value;
                option.setAttribute("role", "option");
                option.setAttribute("aria-selected", String(value === selected[0]));
                const name = document.createElement("span");
                name.textContent = label;
                const kind = document.createElement("small");
                kind.textContent = value === "primary" ? "Primary" : value === "fallback" ? "Fallback" : "Local";
                option.append(name, kind);
                return option;
            }));
        }
        const effort = localStorage.getItem("q3vl_assistant_reasoning_effort") || config.reasoning_effort || "low";
        const effortButton = document.querySelector("#q3vl_assistant_reasoning");
        if (effortButton) {
            effortButton.dataset.q3vlEffort = effort;
            const effortLabel = effort === "max" ? t("settings.reasoning_max", "最大") : effort === "high" ? t("settings.reasoning_high", "高") : t("settings.reasoning_low", "低");
            const text = effortButton.querySelector("span");
            if (text) text.textContent = effort;
            effortButton.title = `${t("settings.reasoning_effort", "推理强度")}: ${effortLabel}`;
            effortButton.setAttribute("aria-label", effortButton.title);
        }
    }

    const assistantSettingPages = [
        {
            id: "route", label: "模型路由", description: "选择主后端和发送策略。", fields: [
                { name: "backend", label: "主后端", type: "select", value: "moyuu", options: [["openai", "OpenAI-compatible"], ["moyuu", "Moyuu Gemini native"], ["deepseek", "DeepSeek"], ["local-qwen-once", "本地模型一次性"], ["local-lmcpp", "本地接入点"]] },
                { name: "teacher_mode", label: "教师脱敏策略", type: "select", value: "qwen-redact", options: [["qwen-redact", "本地模型脱敏"], ["regex", "仅占位符脱敏"]] },
                { name: "sanitize_sensitive", label: "发送远端模型前脱敏提示词", type: "switch", value: "1", keywords: "敏感 隐私 占位符" }
            ]
        },
        {
            id: "remote", label: "远端模型", description: "连接、密钥和远端推理参数。", fields: [
                { name: "endpoint", label: "Base URL", value: "https://moyuu.cc", keywords: "地址 endpoint 接入点" },
                { name: "fallback_endpoint", label: "备用 Base URL", value: "https://hk-api.moyuu.cc", keywords: "fallback 备用地址" },
                { name: "model", label: "远端模型名称", value: "gemini-3.5-flash-preview" },
                { name: "fallback_backend", label: "Fallback 后端", type: "select", value: "openai", options: [["openai", "OpenAI-compatible"], ["moyuu", "Moyuu Gemini native"], ["deepseek", "DeepSeek"]] },
                { name: "fallback_model", label: "Fallback 模型", value: "grok-4.5", keywords: "fallback 备用模型" },
                { name: "api_key_openai", label: "OpenAI-compatible API Key", type: "password", value: "" },
                { name: "api_key_moyuu", label: "Moyuu API Key", type: "password", value: "" },
                { name: "api_key_deepseek", label: "DeepSeek API Key", type: "password", value: "" },
                { name: "reasoning_effort", label: "推理强度", type: "select", value: "low", options: [["low", "低（推荐）"], ["high", "高"], ["max", "最大"]] },
                { name: "max_tokens", label: "最大 token 数", type: "number", value: "8192", min: "512", max: "65536", step: "512" }
            ]
        },
        {
            id: "local", label: "本地推理", description: "文本代理与视觉分析共用的推理参数。", fields: [
                { name: "local_text_thinking", label: "文本 Thinking", type: "switch", value: "0" },
                { name: "vision_thinking", label: "视觉 Thinking", type: "switch", value: "0" },
                { name: "local_max_tokens", label: "本地最大 token 数", type: "number", value: "8192", min: "512", max: "65536", step: "512" },
                { name: "n_ctx", label: "上下文长度 n_ctx", type: "number", value: "16384", min: "1024", max: "32768", step: "1024" },
                { name: "local_temperature", label: "Temperature", type: "number", value: "0.25", min: "0", max: "1.5", step: "0.05" },
                { name: "local_top_p", label: "Top P", type: "number", value: "0.9", min: "0.1", max: "1", step: "0.05" },
                { name: "local_n_gpu_layers", label: "GPU layers", type: "number", value: "-1", min: "-1", max: "200", step: "1", hint: "-1 = 尽可能全部加载到 GPU" },
                { name: "local_timeout", label: "加载与请求超时（秒）", type: "number", value: "180", min: "30", max: "600", step: "10" }
            ]
        },
        {
            id: "paths", label: "模型与路径", description: "常驻服务和临时 llama-server 使用的模型文件。", fields: [
                { name: "vision_preset", label: "共享多模态模型预设", type: "select", value: "Qwen3.5 原版 9B", options: [["Gemma 4 12B", "Gemma 4 12B"], ["Qwen3.5 原版 9B", "Qwen3.5 原版 9B"], ["Qwen3.5 破限版 9B", "Qwen3.5 破限版 9B"], ["自定义", "自定义"]] },
                { name: "local_endpoint", label: "本地文本接入点", value: "http://127.0.0.1:8080/v1" },
                { name: "local_model", label: "本地文本模型名称", value: "qwen3.5-9b-vlm" },
                { name: "vision_endpoint", label: "视觉接入点", value: "http://127.0.0.1:8080/v1" },
                { name: "vision_model", label: "视觉模型别名", value: "qwen3.5-9b-vlm" },
                { name: "vision_model_path", label: "模型 GGUF 路径", value: "E:\\AI\\lmcpp\\models\\Qwen3.5-9B-GGUF\\Qwen3.5-9B-UD-Q6_K_XL.gguf", keywords: "model gguf 文件" },
                { name: "vision_mmproj_path", label: "mmproj GGUF 路径", value: "E:\\AI\\lmcpp\\models\\Qwen3.5-9B-GGUF\\mmproj-F16.gguf" },
                { name: "llama_server_path", label: "llama-server.exe 路径", value: "E:\\AI\\lmcpp\\llama.cpp\\llama-server.exe" }
            ]
        }
    ];

    function migrateAssistantRouteDefaults() {
        const migrationKey = "q3vl_assistant_route_defaults_version";
        if (localStorage.getItem(migrationKey) === "2") return false;
        const backendKey = "q3vl_assistant_backend";
        const modelKey = "q3vl_assistant_model";
        const backend = localStorage.getItem(backendKey);
        const model = localStorage.getItem(modelKey);
        if (backend === null && model === null) return false;
        const oldOpenAiDefault = (backend === "openai" || backend === null) && (!model || model === "gemini-3.5-flash-preview");
        const oldMoyuuDefault = backend === "moyuu" && model === "gemini-3.1-pro-high";
        if (oldOpenAiDefault || oldMoyuuDefault) {
            localStorage.setItem(backendKey, "moyuu");
            localStorage.setItem(modelKey, "gemini-3.5-flash-preview");
        }
        if (localStorage.getItem("q3vl_assistant_fallback_backend") === null) {
            localStorage.setItem("q3vl_assistant_fallback_backend", "openai");
        }
        if (localStorage.getItem("q3vl_assistant_fallback_model") === null) {
            localStorage.setItem("q3vl_assistant_fallback_model", "grok-4.5");
        }
        localStorage.setItem(migrationKey, "2");
        return true;
    }

    function migrateAssistantReasoningDefault() {
        const migrationKey = "q3vl_assistant_reasoning_default_version";
        if (localStorage.getItem(migrationKey) === "1") return false;
        const settingKey = "q3vl_assistant_reasoning_effort";
        if (localStorage.getItem(settingKey) === "high") localStorage.setItem(settingKey, "low");
        localStorage.setItem(migrationKey, "1");
        return true;
    }

    function assistantStoredSetting(field) {
        const key = `q3vl_assistant_${field.name}`;
        const stored = localStorage.getItem(key);
        if (stored !== null) return stored;
        if (typeof opts === "object" && opts !== null && Object.prototype.hasOwnProperty.call(opts, key)) {
            const value = opts[key];
            return typeof value === "boolean" ? (value ? "1" : "0") : String(value ?? field.value);
        }
        return String(field.value ?? "");
    }

    function createAssistantSettingField(field) {
        const label = document.createElement("label");
        label.className = "q3vl-config-field";
        label.dataset.q3vlSearch = `${field.label} ${field.name} ${field.keywords || ""}`.toLowerCase();
        const heading = document.createElement("span");
        heading.className = "q3vl-config-label";
        heading.textContent = field.label;
        label.appendChild(heading);

        let input;
        if (field.type === "select") {
            input = document.createElement("select");
            (field.options || []).forEach(function ([value, text]) {
                const option = document.createElement("option");
                option.value = value;
                option.textContent = text;
                input.appendChild(option);
            });
            label.appendChild(input);
        } else if (field.type === "switch") {
            label.classList.add("q3vl-config-switch");
            input = document.createElement("input");
            input.type = "checkbox";
            input.checked = ["1", "true", "on"].includes(assistantStoredSetting(field).toLowerCase());
            const track = document.createElement("i");
            track.setAttribute("aria-hidden", "true");
            label.appendChild(input);
            label.appendChild(track);
        } else {
            const holder = document.createElement("div");
            holder.className = field.type === "password" ? "q3vl-config-secret" : "q3vl-config-input";
            input = document.createElement("input");
            input.type = field.type === "password" ? "password" : field.type === "number" ? "number" : "text";
            if (field.min !== undefined) input.min = field.min;
            if (field.max !== undefined) input.max = field.max;
            if (field.step !== undefined) input.step = field.step;
            input.value = assistantStoredSetting(field);
            input.spellcheck = false;
            holder.appendChild(input);
            if (field.type === "password") {
                const reveal = document.createElement("button");
                reveal.type = "button";
                reveal.className = "q3vl-config-reveal";
                reveal.textContent = "显示";
                reveal.addEventListener("click", function () {
                    const hidden = input.type === "password";
                    input.type = hidden ? "text" : "password";
                    reveal.textContent = hidden ? "隐藏" : "显示";
                });
                holder.appendChild(reveal);
            }
            label.appendChild(holder);
        }

        if (field.type === "select") input.value = assistantStoredSetting(field);
        input.dataset.q3vlSetting = field.name;
        input.addEventListener("change", function () {
            const value = input.type === "checkbox" ? (input.checked ? "1" : "0") : input.value;
            localStorage.setItem(`q3vl_assistant_${field.name}`, value);
            const status = settingsPanel()?.querySelector("#q3vl_config_status");
            if (status) status.textContent = "已保存";
            syncAssistantRouteLabel();
        });
        if (input.type !== "checkbox") input.addEventListener("input", function () { input.dispatchEvent(new Event("change")); });
        if (field.hint) {
            const hint = document.createElement("small");
            hint.textContent = field.hint;
            label.appendChild(hint);
        }
        return label;
    }

    function activateAssistantSettingPage(panel, pageId) {
        panel.dataset.q3vlPage = pageId;
        panel.querySelectorAll("[data-q3vl-config-page]").forEach(function (button) {
            const active = button.dataset.q3vlConfigPage === pageId;
            button.classList.toggle("q3vl-config-nav-active", active);
            button.setAttribute("aria-selected", String(active));
        });
        panel.querySelectorAll("[data-q3vl-config-panel]").forEach(function (page) {
            page.hidden = page.dataset.q3vlConfigPanel !== pageId;
        });
    }

    function filterAssistantSettings(panel, query) {
        const needle = String(query || "").trim().toLowerCase();
        let matches = 0;
        panel.classList.toggle("q3vl-config-searching", Boolean(needle));
        panel.querySelectorAll("[data-q3vl-config-panel]").forEach(function (page) {
            let pageMatches = 0;
            page.querySelectorAll(".q3vl-config-field").forEach(function (field) {
                const visible = !needle || field.dataset.q3vlSearch.includes(needle);
                field.hidden = !visible;
                if (visible && needle) pageMatches += 1;
            });
            page.hidden = needle ? pageMatches === 0 : page.dataset.q3vlConfigPanel !== panel.dataset.q3vlPage;
            matches += pageMatches;
        });
        const result = panel.querySelector("#q3vl_config_search_result");
        if (result) result.textContent = needle ? `${matches} 项匹配` : "";
    }

    function setupAssistantSettingsWindow() {
        const existing = settingsPanel();
        if (existing) return existing;
        const panel = document.createElement("div");
        panel.id = "q3vl_assistant_settings_panel";
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", "助手设置");
        panel.innerHTML = `
            <div class="q3vl-config-head"><div><strong>助手设置</strong><span id="q3vl_config_status">自动保存到当前浏览器</span></div><button type="button" id="q3vl_config_close" aria-label="关闭">×</button></div>
            <div class="q3vl-config-search"><input id="q3vl_config_search" type="search" placeholder="搜索设置，例如 token、GGUF、API Key"><span id="q3vl_config_search_result"></span></div>
            <div class="q3vl-config-layout"><nav class="q3vl-config-nav" aria-label="设置分类"></nav><main class="q3vl-config-pages"></main></div>
        `;
        const nav = panel.querySelector(".q3vl-config-nav");
        const pages = panel.querySelector(".q3vl-config-pages");
        assistantSettingPages.forEach(function (page) {
            const button = document.createElement("button");
            button.type = "button";
            button.dataset.q3vlConfigPage = page.id;
            button.textContent = page.label;
            button.addEventListener("click", function () {
                panel.querySelector("#q3vl_config_search").value = "";
                filterAssistantSettings(panel, "");
                activateAssistantSettingPage(panel, page.id);
            });
            nav.appendChild(button);
            const section = document.createElement("section");
            section.dataset.q3vlConfigPanel = page.id;
            const header = document.createElement("header");
            const title = document.createElement("h3");
            title.textContent = page.label;
            const description = document.createElement("p");
            description.textContent = page.description;
            header.appendChild(title);
            header.appendChild(description);
            section.appendChild(header);
            const grid = document.createElement("div");
            grid.className = "q3vl-config-grid";
            page.fields.forEach(function (field) { grid.appendChild(createAssistantSettingField(field)); });
            section.appendChild(grid);
            pages.appendChild(section);
        });
        document.body.appendChild(panel);
        restoreAssistantPosition(panel, "q3vl_settings_position");
        makeAssistantDraggable(panel, panel.querySelector(".q3vl-config-head"), "q3vl_settings_position");
        activateAssistantSettingPage(panel, "route");
        panel.querySelector("#q3vl_config_search").addEventListener("input", function (event) { filterAssistantSettings(panel, event.target.value); });
        panel.querySelector("#q3vl_config_close").addEventListener("click", function () { panel.classList.remove("q3vl-config-open"); });
        panel.addEventListener("keydown", function (event) { if (event.key === "Escape") panel.classList.remove("q3vl-config-open"); });
        return panel;
    }

    function importForgeAssistantSettings() {
        migrateAssistantRouteDefaults();
        migrateAssistantReasoningDefault();
        if (importForgeAssistantSettings.pending || localStorage.getItem("q3vl_assistant_floating_settings_imported") === "1") return;
        importForgeAssistantSettings.pending = true;
        fetch("/qwen3vl-prompt-tools/settings-export")
            .then(function (response) { return response.ok ? response.json() : null; })
            .then(function (config) {
                if (!config) return;
                Object.entries(config).forEach(function ([name, value]) {
                    const key = `q3vl_assistant_${name}`;
                    if (localStorage.getItem(key) !== null) return;
                    localStorage.setItem(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value ?? ""));
                });
                migrateAssistantRouteDefaults();
                migrateAssistantReasoningDefault();
                localStorage.setItem("q3vl_assistant_floating_settings_imported", "1");
                syncAssistantRouteLabel();
            }).catch(function () {
                window.setTimeout(function () { importForgeAssistantSettings.pending = false; }, 5000);
            });
    }

    function openAssistantSettings() {
        const panel = setupAssistantSettingsWindow();
        document.querySelector("#q3vl_assistant_panel")?.classList.remove("q3vl-assistant-open");
        panel.classList.add("q3vl-config-open");
        window.requestAnimationFrame(function () { panel.querySelector("#q3vl_config_search")?.focus(); });
    }

    function acceptAssistantImageFile(file) {
        return readAssistantImageFile(file)
            .then(setAssistantAttachment)
            .catch(function (error) { addAssistantMessage("error", String(error.message || error)); });
    }

    function setupAssistantWindow() {
        if (!q3vlMainApp()) {
            removeAssistantWindow();
            return;
        }
        const existingLaunchers = document.querySelectorAll("#q3vl_assistant_launcher");
        const existingPanels = document.querySelectorAll("#q3vl_assistant_panel");
        if (existingLaunchers.length === 1 && existingPanels.length === 1) {
            syncAssistantRouteLabel();
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
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", t("assistant.title", "LLM 提示词助手"));
        panel.innerHTML = `
            <div class="q3vl-assistant-head"><div class="q3vl-assistant-brand"><div><strong>${t("assistant.title", "LLM 提示词助手")}</strong></div></div><div class="q3vl-assistant-head-buttons"><button type="button" id="q3vl_assistant_settings_open" class="q3vl-assistant-icon-button" title="${t("assistant.settings", "设置")}" aria-label="${t("assistant.settings", "设置")}">⚙</button><button type="button" id="q3vl_assistant_close" class="q3vl-assistant-close" title="${t("assistant.close", "关闭")}" aria-label="${t("assistant.close", "关闭")}">×</button></div></div>
            <div id="q3vl_assistant_messages" role="log" aria-live="polite"><div class="q3vl-assistant-empty"><strong>${t("assistant.empty.title", "从当前提示词开始")}</strong><div class="q3vl-assistant-quick-actions"><button type="button" data-q3vl-assistant-prompt="Read the current prompt and style template, then analyze its subject, composition, camera, lighting, and spatial relationships. Do not edit it.">${t("assistant.quick.analyze", "分析结构")}</button><button type="button" data-q3vl-assistant-prompt="Read the current prompt, then improve its composition and spatial relationships. Apply the changes directly with edit_prompt.">${t("assistant.quick.compose", "强化构图")}</button><button type="button" data-q3vl-assistant-prompt="Read the current prompt, remove redundancy and ambiguity while preserving its intent. Apply the refined prompt directly with edit_prompt.">${t("assistant.quick.refine", "精炼表达")}</button></div></div></div>
            <div class="q3vl-assistant-composer">
                <div id="q3vl_assistant_attachment" class="q3vl-assistant-attachment q3vl-assistant-attachment-empty"></div>
                <textarea id="q3vl_assistant_input" rows="1" aria-label="${t("assistant.input.placeholder", "描述你想分析、补充或修改的提示词内容...")}" placeholder="${t("assistant.input.placeholder", "描述你想分析、补充或修改的提示词内容...")}"></textarea>
                <div class="q3vl-assistant-actions">
                    <div class="q3vl-assistant-action-group"><button type="button" id="q3vl_assistant_attach" class="q3vl-assistant-icon-action" title="${t("assistant.attach", "附图")}" aria-label="${t("assistant.attach", "附图")}">${assistantIcon("attach")}</button><button type="button" id="q3vl_assistant_read" class="q3vl-assistant-icon-action" title="${t("assistant.read", "读取")}" aria-label="${t("assistant.read", "读取")}">${assistantIcon("read")}</button><button type="button" id="q3vl_assistant_clear" class="q3vl-assistant-icon-action" title="${t("assistant.clear", "清空")}" aria-label="${t("assistant.clear", "清空")}">${assistantIcon("clear")}</button></div>
                    <div class="q3vl-assistant-action-group q3vl-assistant-route-controls"><button type="button" id="q3vl_assistant_reasoning" class="q3vl-assistant-compact-control q3vl-assistant-runtime-control">${assistantIcon("reasoning")}<span>low</span></button><div class="q3vl-assistant-model-control">${assistantIcon("model")}<button type="button" id="q3vl_assistant_model" class="q3vl-assistant-runtime-control" aria-haspopup="listbox" aria-expanded="false"><span class="q3vl-assistant-model-name"></span>${assistantIcon("chevron")}</button><div id="q3vl_assistant_model_menu" class="q3vl-assistant-model-menu" role="listbox" aria-label="${t("settings.model", "模型")}" hidden></div></div><button type="button" id="q3vl_assistant_send" class="q3vl-assistant-icon-action q3vl-assistant-primary" title="${t("assistant.send", "发送")}" aria-label="${t("assistant.send", "发送")}"><span class="q3vl-send-icon">${assistantIcon("send")}</span><span class="q3vl-stop-icon">${assistantIcon("stop")}</span></button></div>
                </div>
                <input id="q3vl_assistant_file" type="file" accept="image/*" hidden>
            </div>
        `;
        document.body.appendChild(panel);
        const emptyStateTemplate = panel.querySelector(".q3vl-assistant-empty")?.cloneNode(true);
        restoreAssistantPosition(panel);
        syncAssistantRouteLabel();
        panel.querySelector("#q3vl_assistant_settings_open").addEventListener("click", openAssistantSettings);
        const modelButton = panel.querySelector("#q3vl_assistant_model");
        const modelMenu = panel.querySelector("#q3vl_assistant_model_menu");
        function toggleModelMenu(open) {
            const next = open === undefined ? modelMenu.hidden : Boolean(open);
            modelMenu.hidden = !next;
            modelButton.setAttribute("aria-expanded", String(next));
            panel.querySelector(".q3vl-assistant-model-control").classList.toggle("q3vl-model-open", next);
        }
        modelButton.addEventListener("click", function () { if (!modelButton.disabled) toggleModelMenu(); });
        modelButton.addEventListener("keydown", function (event) {
            if (event.key === "Escape" && !modelMenu.hidden) { toggleModelMenu(false); event.preventDefault(); return; }
            if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
            event.preventDefault();
            toggleModelMenu(true);
            const options = Array.from(modelMenu.querySelectorAll("button"));
            const selected = options.findIndex(function (option) { return option.getAttribute("aria-selected") === "true"; });
            options[Math.max(0, selected < 0 ? 0 : selected)]?.focus();
        });
        modelMenu.addEventListener("click", function (event) {
            const option = event.target.closest("button[data-q3vl-route]");
            if (!option) return;
            localStorage.setItem("q3vl_assistant_chat_model_route", option.dataset.q3vlRoute);
            toggleModelMenu(false);
            syncAssistantRouteLabel();
            modelButton.focus();
        });
        modelMenu.addEventListener("keydown", function (event) {
            const options = Array.from(modelMenu.querySelectorAll("button"));
            const index = options.indexOf(document.activeElement);
            let next = index;
            if (event.key === "ArrowDown") next = (index + 1) % options.length;
            else if (event.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = options.length - 1;
            else if (event.key === "Escape") { toggleModelMenu(false); modelButton.focus(); event.preventDefault(); return; }
            else return;
            event.preventDefault();
            options[next]?.focus();
        });
        if (assistantState.modelMenuOutsideHandler) document.removeEventListener("pointerdown", assistantState.modelMenuOutsideHandler);
        assistantState.modelMenuOutsideHandler = function (event) { if (!panel.querySelector(".q3vl-assistant-model-control").contains(event.target)) toggleModelMenu(false); };
        document.addEventListener("pointerdown", assistantState.modelMenuOutsideHandler);
        panel.querySelector("#q3vl_assistant_reasoning").addEventListener("click", function (event) {
            const levels = ["low", "high", "max"];
            const current = event.currentTarget.dataset.q3vlEffort || "low";
            const next = levels[(levels.indexOf(current) + 1) % levels.length];
            localStorage.setItem("q3vl_assistant_reasoning_effort", next);
            const setting = settingsPanel()?.querySelector('[data-q3vl-setting="reasoning_effort"]');
            if (setting) setting.value = next;
            syncAssistantRouteLabel();
        });
        launcher.addEventListener("click", function () {
            if (launcher.dataset.q3vlSuppressClick === "1") return;
            settingsPanel()?.classList.remove("q3vl-config-open");
            const open = panel.classList.toggle("q3vl-assistant-open");
            if (open) window.requestAnimationFrame(function () { panel.querySelector("#q3vl_assistant_input")?.focus(); });
        });
        panel.querySelector("#q3vl_assistant_close").addEventListener("click", function () {
            panel.classList.remove("q3vl-assistant-open");
        });
        makeAssistantLauncherDraggable(launcher, panel);
        makeAssistantDraggable(panel, panel.querySelector(".q3vl-assistant-head"));
        panel.querySelector("#q3vl_assistant_send").addEventListener("click", function () {
            if (assistantState.running) {
                cancelAssistantRun();
                return;
            }
            toggleModelMenu(false);
            const input = panel.querySelector("#q3vl_assistant_input");
            const text = input.value.trim();
            const attachment = assistantState.attachment;
            if (!text && !attachment) return;
            input.value = "";
            resizeAssistantInput(input);
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
            acceptAssistantImageFile(file);
        });
        const assistantInput = panel.querySelector("#q3vl_assistant_input");
        assistantInput.addEventListener("input", function () { resizeAssistantInput(assistantInput); });
        assistantInput.addEventListener("keydown", function (event) {
            if (event.key !== "Enter") return;
            if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                panel.querySelector("#q3vl_assistant_send").click();
            } else {
                event.stopPropagation();
            }
        });
        assistantInput.addEventListener("paste", function (event) {
            const image = Array.from(event.clipboardData?.files || []).find(function (file) { return String(file.type || "").startsWith("image/"); });
            if (!image) return;
            event.preventDefault();
            acceptAssistantImageFile(image);
        });
        const composer = panel.querySelector(".q3vl-assistant-composer");
        composer.addEventListener("dragover", function (event) {
            if (!Array.from(event.dataTransfer?.items || []).some(function (item) { return String(item.type || "").startsWith("image/"); })) return;
            event.preventDefault();
            composer.classList.add("q3vl-assistant-drop-active");
        });
        composer.addEventListener("dragleave", function (event) {
            if (!composer.contains(event.relatedTarget)) composer.classList.remove("q3vl-assistant-drop-active");
        });
        composer.addEventListener("drop", function (event) {
            composer.classList.remove("q3vl-assistant-drop-active");
            const image = Array.from(event.dataTransfer?.files || []).find(function (file) { return String(file.type || "").startsWith("image/"); });
            if (!image) return;
            event.preventDefault();
            acceptAssistantImageFile(image);
        });
        function bindQuickActions(root) {
            root.querySelectorAll("[data-q3vl-assistant-prompt]").forEach(function (button) {
                button.addEventListener("click", function () {
                    if (!assistantState.running) runAssistantLoop(button.dataset.q3vlAssistantPrompt || "", null, button.textContent.trim());
                });
            });
        }
        bindQuickActions(panel);
        panel.querySelector("#q3vl_assistant_read").addEventListener("click", function () {
            runAssistantLoop(t("assistant.read_prompt", "Read the current prompt and WebUI style template. Briefly summarize the composition, trigger words, and spatial relationships they describe. If both are empty, say they are empty."), null, t("assistant.read", "读取"));
        });
        panel.querySelector("#q3vl_assistant_clear").addEventListener("click", function () {
            if (assistantState.running) return;
            assistantState.messages = [];
            setAssistantAttachment(null);
            const messages = panel.querySelector("#q3vl_assistant_messages");
            messages.replaceChildren(emptyStateTemplate?.cloneNode(true) || document.createTextNode(""));
            bindQuickActions(messages);
        });
        panel.addEventListener("keydown", function (event) {
            if (event.key === "Escape" && !assistantState.running) panel.classList.remove("q3vl-assistant-open");
        });
        resizeAssistantInput(assistantInput);
        renderAssistantAttachment();
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
                const fallbackWidth = Math.min(panel.id === "q3vl_assistant_settings_panel" ? 820 : 480, window.innerWidth - 16);
                const fallbackHeight = Math.min(panel.id === "q3vl_assistant_settings_panel" ? 600 : 680, window.innerHeight - 16);
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
        importForgeAssistantSettings();
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

    if (typeof onOptionsChanged === "function") onOptionsChanged(syncAssistantRouteLabel);
})();
