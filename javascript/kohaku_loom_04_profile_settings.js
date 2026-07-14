(function () {
    const tools = window.kohakuLoom = window.kohakuLoom || {};
    let selectedProfileId = "";
    let settingsReturnFocus = null;

    function t(key, fallback) {
        if (typeof tools.tr !== "function") return fallback;
        const value = tools.tr(key);
        return value && value !== key ? value : fallback;
    }

    function protocolAbbreviation(protocol) {
        return protocol === "gemini-native" ? "GEM" : protocol === "openai-chat-completions" ? "OAI" : "API";
    }

    function profileSettingsVisibility(profile) {
        const value = profile || {};
        const capabilities = value.capabilities || {};
        const local = value.runtime === "llama-endpoint" || value.runtime === "llama-once";
        return {
            endpoint: value.runtime !== "llama-once",
            fallback_endpoints: value.runtime === "remote-http",
            api_key: value.runtime !== "llama-once",
            local: local,
            mmproj_path: local && Boolean(capabilities.vision),
            thinking: local && Boolean(capabilities.reasoning),
            reasoning_effort: Boolean(capabilities.reasoning),
            temperature: value.model_info?.temperature_supported !== false
        };
    }

    function buildModelProfileTestPayload(projection, ping) {
        return Object.assign({}, projection, {
            messages: [{ role: "user", content: String(ping || "Ping. Reply with OK.") }],
            stream: false,
            disable_tools: true,
            teacher_mode: "regex",
            qwen_teacher_enabled: false
        });
    }

    function reasoningOptions(profile) {
        const labels = {
            none: ["profiles.reasoning.none", "关闭"], minimal: ["profiles.reasoning.minimal", "最小"],
            low: ["profiles.reasoning.low", "低"], medium: ["profiles.reasoning.medium", "中"],
            high: ["profiles.reasoning.high", "高"], xhigh: ["profiles.reasoning.xhigh", "极高"], max: ["profiles.reasoning.max", "最大"]
        };
        const info = profile?.model_info || {};
        let values = Array.isArray(info.reasoning_efforts) && info.reasoning_efforts.length ? info.reasoning_efforts.slice() : ["low", "high", "max"];
        if (info.reasoning_toggle && !values.includes("none")) values.unshift("none");
        if (info.source !== "models.dev" && !values.includes(profile?.parameters?.reasoning_effort)) values.push(profile?.parameters?.reasoning_effort || "low");
        return values.filter(function (value, index) { return labels[value] && values.indexOf(value) === index; }).map(function (value) {
            return [value, labels[value][0], labels[value][1]];
        });
    }

    function button(label, className) {
        const element = document.createElement("button");
        element.type = "button";
        element.className = className || "";
        element.textContent = label;
        return element;
    }

    function option(value, label) {
        const element = document.createElement("option");
        element.value = value;
        element.textContent = label;
        return element;
    }

    function section(title, className, description) {
        const element = document.createElement("section");
        element.className = `loom-profile-section ${className || ""}`.trim();
        const heading = document.createElement("h3");
        heading.textContent = title;
        element.appendChild(heading);
        if (description) {
            const hint = document.createElement("p");
            hint.className = "loom-profile-section-hint";
            hint.textContent = description;
            element.appendChild(hint);
        }
        return element;
    }

    function profileWorkspaceTabs(profile) {
        const tabs = ["overview", "connection", "generation"];
        if (["llama-endpoint", "llama-once"].includes(profile?.runtime)) tabs.push("local");
        return tabs;
    }

    function profileRoleLabels(state, profile) {
        const roles = [];
        if (profile?.id === state?.active_profile_id) roles.push("active");
        if (profile?.id === state?.teacher_profile_id) roles.push("teacher");
        if (profile?.id === state?.session_profile_id) roles.push("session");
        return roles;
    }

    function runtimeLabel(profile) {
        const labels = {
            "remote-http": ["profiles.runtime.remote", "Remote HTTP"],
            "llama-endpoint": ["profiles.runtime.endpoint", "llama endpoint"],
            "llama-once": ["profiles.runtime.once", "llama once"]
        };
        const label = labels[profile?.runtime] || ["", profile?.runtime || ""];
        return label[0] ? t(label[0], label[1]) : label[1];
    }

    function fieldLabel(key, fallback) {
        const label = document.createElement("span");
        label.className = "loom-profile-label";
        label.textContent = t(key, fallback);
        return label;
    }

    function nestedPatch(path, value) {
        const parts = path.split(".");
        if (parts.length === 1) return { [parts[0]]: value };
        return { [parts[0]]: { [parts[1]]: value } };
    }

    function fieldValue(profile, path) {
        return path.split(".").reduce(function (value, key) {
            return value && value[key] !== undefined ? value[key] : "";
        }, profile);
    }

    function dispatchProfileChange(state) {
        if (typeof window.dispatchEvent !== "function" || typeof window.CustomEvent !== "function") return;
        window.dispatchEvent(new CustomEvent("loom:model-profiles-changed", { detail: state }));
    }

    function updateStatus(panel, message, type) {
        const status = panel && panel.querySelector("#loom_profile_status");
        if (!status) return;
        status.textContent = message;
        status.dataset.status = type || "";
    }

    function closeModelProfileSettings(panel) {
        if (!panel) return;
        panel.classList.remove("loom-config-open");
        document.getElementById("loom_assistant_settings_backdrop")?.classList.remove("loom-config-open");
        settingsReturnFocus?.focus();
    }

    function persistPatch(panel, profile, patch) {
        try {
            const updated = tools.profileStore.update(profile.id, patch);
            updateStatus(panel, t("profiles.status.saved", "Saved"), "success");
            dispatchProfileChange(tools.profileStore.load());
            return updated;
        } catch (_error) {
            updateStatus(panel, t("profiles.status.invalid", "Check this value and try again."), "error");
            return null;
        }
    }

    function persistField(panel, profile, path, value) {
        return persistPatch(panel, profile, nestedPatch(path, value));
    }

    function createInputField(panel, profile, config) {
        const label = document.createElement("label");
        label.className = "loom-profile-field";
        label.dataset.profileField = config.path;
        label.appendChild(fieldLabel(config.key, config.label));
        let input;
        if (config.type === "select") {
            input = document.createElement("select");
            config.options.forEach(function (item) { input.appendChild(option(item[0], t(item[1], item[2]))); });
        } else if (config.type === "textarea") {
            input = document.createElement("textarea");
            input.rows = config.rows || 3;
        } else {
            input = document.createElement("input");
            input.type = config.type || "text";
            if (config.min !== undefined) input.min = config.min;
            if (config.max !== undefined) input.max = config.max;
            if (config.step !== undefined) input.step = config.step;
            input.readOnly = Boolean(config.readOnly);
            input.autocomplete = config.type === "password" ? "off" : "on";
        }
        let value = fieldValue(profile, config.path);
        if (config.path === "fallback_endpoints") value = (profile.fallback_endpoints || []).join("\n");
        input.value = config.path === "api_key" && profile.has_api_key && !value ? "" : value;
        if (config.path === "api_key" && profile.has_api_key && !value) input.placeholder = "Stored securely";
        input.dataset.profilePath = config.path;
        input.spellcheck = false;
        const commit = function () {
            let next = input.value;
            if (config.type === "number") {
                if (input.value === "" || !Number.isFinite(Number(input.value))) return;
                next = Number(input.value);
            } else if (config.path === "fallback_endpoints") {
                next = input.value.split(/\r?\n/).map(function (item) { return item.trim(); }).filter(Boolean);
            }
            let patch = nestedPatch(config.path, next);
            if (config.path === "api_key") patch.has_api_key = Boolean(next);
            if (config.path === "runtime" && next !== "remote-http" && profile.protocol === "gemini-native") {
                patch.protocol = "openai-chat-completions";
            } else if (config.path === "protocol" && next === "gemini-native" && profile.runtime !== "remote-http") {
                patch.runtime = "remote-http";
            }
            const updated = persistPatch(panel, profile, patch);
            if (!updated) input.value = config.path === "fallback_endpoints" ? (profile.fallback_endpoints || []).join("\n") : fieldValue(profile, config.path);
            if (updated && config.path === "display_name") {
                renderProfileList(panel, tools.profileStore.load());
                const summaryName = panel.querySelector(".loom-profile-summary h2");
                if (summaryName) summaryName.textContent = updated.display_name;
            }
        };
        if (!config.readOnly) {
            input.addEventListener(config.path === "display_name" ? "input" : "change", commit);
        }
        if (config.type === "password") {
            const secret = document.createElement("div");
            secret.className = "loom-profile-secret";
            secret.appendChild(input);
            const reveal = button(t("profiles.api_key.show", "Show"), "loom-profile-reveal");
            reveal.setAttribute("aria-pressed", "false");
            reveal.addEventListener("click", function () {
                const showing = input.type === "text";
                input.type = showing ? "password" : "text";
                reveal.textContent = showing ? t("profiles.api_key.show", "Show") : t("profiles.api_key.hide", "Hide");
                reveal.setAttribute("aria-pressed", String(!showing));
                input.focus();
            });
            secret.appendChild(reveal);
            label.appendChild(secret);
        } else {
            label.appendChild(input);
        }
        return label;
    }

    function createSwitchField(panel, profile, path, key, fallback) {
        const label = document.createElement("label");
        label.className = "loom-profile-switch";
        label.dataset.profileField = path;
        label.appendChild(fieldLabel(key, fallback));
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = Boolean(fieldValue(profile, path));
        const visual = document.createElement("span");
        visual.setAttribute("aria-hidden", "true");
        input.addEventListener("change", function () {
            const updated = persistField(panel, profile, path, input.checked);
            if (!updated) input.checked = !input.checked;
            if (updated && path === "enabled") {
                renderModelProfileSettings();
                return;
            }
            renderProfileList(panel, tools.profileStore.load());
            applyProfileVisibility(panel, updated || profile);
        });
        label.append(input, visual);
        return label;
    }

    function applyProfileVisibility(panel, profile) {
        const visibility = profileSettingsVisibility(profile);
        panel.querySelectorAll("[data-profile-visible]").forEach(function (element) {
            element.hidden = !visibility[element.dataset.profileVisible];
        });
    }

    function createEditor(panel, state, profile) {
        const editor = document.createElement("div");
        editor.className = "loom-profile-editor";

        const summary = document.createElement("header");
        summary.className = "loom-profile-summary";
        const summaryCopy = document.createElement("div");
        summaryCopy.className = "loom-profile-summary-copy";
        const eyebrow = document.createElement("span");
        eyebrow.className = "loom-profile-eyebrow";
        eyebrow.textContent = t("profiles.selected", "Selected model");
        const name = document.createElement("h2");
        name.textContent = profile.display_name;
        const model = document.createElement("p");
        model.textContent = profile.model_id;
        summaryCopy.append(eyebrow, name, model);
        const current = document.createElement("span");
        current.className = "loom-profile-current-state";
        current.dataset.active = String(profile.id === state.active_profile_id);
        current.textContent = profile.id === state.active_profile_id ? t("profiles.current", "Current model") : t("profiles.available", "Available model");
        summary.append(summaryCopy, current);

        const quick = section(t("profiles.quick.title", "Connect this model"), "loom-profile-quick", t("profiles.quick.hint", "Add your API key, test the connection, and start using it."));
        if (profile.runtime === "remote-http") {
            const keyField = createInputField(panel, profile, { path: "api_key", key: "profiles.api_key", label: "API key", type: "password" });
            keyField.classList.add("loom-profile-key-field");
            quick.appendChild(keyField);
        } else {
            const localReady = document.createElement("div");
            localReady.className = "loom-profile-local-ready";
            const localTitle = document.createElement("strong");
            localTitle.textContent = t("profiles.quick.local", "Local model - no API key needed");
            const localHint = document.createElement("span");
            localHint.textContent = profile.runtime === "llama-once" ? profile.model_path : profile.endpoint;
            localReady.append(localTitle, localHint);
            quick.appendChild(localReady);
        }
        const quickActions = document.createElement("div");
        quickActions.className = "loom-profile-quick-actions";
        const testButton = button(t("profiles.test", "Test connection"), "loom-profile-primary");
        testButton.disabled = !profile.enabled;
        testButton.addEventListener("click", function () { testModelProfileConnection(profile.id, panel, testButton); });
        const activateButton = button(profile.id === state.active_profile_id ? t("profiles.current", "Current model") : t("profiles.use_model", "Use this model"), "loom-profile-use");
        activateButton.disabled = profile.id === state.active_profile_id || !profile.enabled;
        activateButton.addEventListener("click", function () {
            try {
                tools.profileStore.setActive(profile.id);
                dispatchProfileChange(tools.profileStore.load());
                renderModelProfileSettings();
            } catch (_error) {
                updateStatus(panel, t("profiles.active.disabled", "Enable this profile before making it active."), "error");
            }
        });
        quickActions.append(testButton, activateButton);
        quick.appendChild(quickActions);

        if (profile.runtime === "remote-http" && typeof tools.syncProfileFromModelsDev === "function") {
            const catalogRow = document.createElement("div");
            catalogRow.className = "loom-profile-catalog-row";
            const syncButton = button(t("profiles.models_dev.sync", "Get parameters from models.dev"), "loom-profile-secondary");
            const source = document.createElement("span");
            source.className = "loom-profile-catalog-status";
            source.textContent = profile.model_info?.source === "models.dev"
                ? `${profile.model_info.provider_id}/${profile.model_info.matched_model_id}` : t("profiles.models_dev.hint", "Sync model capabilities and limits");
            syncButton.addEventListener("click", async function () {
                syncButton.disabled = true;
                updateStatus(panel, t("profiles.models_dev.loading", "Querying models.dev..."), "pending");
                try {
                    const result = await tools.syncProfileFromModelsDev(profile);
                    if (!persistPatch(panel, profile, result.patch)) throw new Error("profile update failed");
                    updateStatus(panel, t("profiles.models_dev.success", "Updated model parameters from models.dev."), "success");
                    renderModelProfileSettings();
                } catch (_error) {
                    updateStatus(panel, t("profiles.models_dev.error", "No exact model match found on models.dev."), "error");
                    syncButton.disabled = false;
                }
            });
            catalogRow.append(syncButton, source);
            quick.appendChild(catalogRow);
        }

        const advanced = document.createElement("details");
        advanced.className = "loom-profile-advanced";
        const advancedSummary = document.createElement("summary");
        advancedSummary.textContent = t("profiles.advanced", "Advanced settings");
        const advancedBody = document.createElement("div");
        advancedBody.className = "loom-profile-advanced-body";
        const roleSelectors = panel.querySelector(".loom-profile-role-selectors");
        if (roleSelectors) advancedBody.appendChild(roleSelectors);

        const basic = section(t("profiles.section.basic", "Basic information"), "", t("profiles.section.basic.hint", "Identity, protocol, and availability for this model."));
        const basicGrid = document.createElement("div");
        basicGrid.className = "loom-profile-grid";
        [
            { path: "id", key: "profiles.id", label: "Profile ID", readOnly: true },
            { path: "display_name", key: "profiles.display_name", label: "Display name" },
            { path: "model_id", key: "profiles.model_id", label: "Model ID" },
            { path: "protocol", key: "profiles.protocol", label: "Protocol", type: "select", options: [["gemini-native", "profiles.protocol.gemini", "Gemini native"], ["openai-chat-completions", "profiles.protocol.openai", "OpenAI chat completions"]] },
            { path: "runtime", key: "profiles.runtime", label: "Runtime", type: "select", options: [["remote-http", "profiles.runtime.remote", "Remote HTTP"], ["llama-endpoint", "profiles.runtime.endpoint", "llama endpoint"], ["llama-once", "profiles.runtime.once", "llama once"]] }
        ].forEach(function (config) { basicGrid.appendChild(createInputField(panel, profile, config)); });
        basicGrid.appendChild(createSwitchField(panel, profile, "enabled", "profiles.enabled", "Enabled"));
        basic.appendChild(basicGrid);

        const capabilities = section(t("profiles.section.capabilities", "Capabilities"), "", t("profiles.section.capabilities.hint", "Declare what the model can accept and return."));
        const switchGrid = document.createElement("div");
        switchGrid.className = "loom-profile-switch-grid";
        [["tools", "Tools"], ["vision", "Vision"], ["streaming", "Streaming"], ["reasoning", "Reasoning"]].forEach(function (item) {
            switchGrid.appendChild(createSwitchField(panel, profile, `capabilities.${item[0]}`, `profiles.capability.${item[0]}`, item[1]));
        });
        capabilities.appendChild(switchGrid);
        const connection = section(t("profiles.section.connection", "Connection"), "", t("profiles.section.connection.hint", "Credentials and endpoints used to reach this model."));
        const connectionGrid = document.createElement("div");
        connectionGrid.className = "loom-profile-grid";
        const endpoint = createInputField(panel, profile, { path: "endpoint", key: "profiles.endpoint", label: "Endpoint" });
        endpoint.dataset.profileVisible = "endpoint";
        const fallbacks = createInputField(panel, profile, { path: "fallback_endpoints", key: "profiles.fallback_endpoints", label: "Fallback endpoints", type: "textarea", rows: 3 });
        fallbacks.dataset.profileVisible = "fallback_endpoints";
        connectionGrid.append(endpoint, fallbacks);
        if (profile.runtime !== "remote-http") {
            const apiKey = createInputField(panel, profile, { path: "api_key", key: "profiles.api_key", label: "API key", type: "password" });
            apiKey.dataset.profileVisible = "api_key";
            connectionGrid.appendChild(apiKey);
        }
        connection.appendChild(connectionGrid);

        const generation = section(t("profiles.section.generation", "Generation"), "", t("profiles.section.generation.hint", "Default sampling, reasoning, and privacy behavior."));
        const generationGrid = document.createElement("div");
        generationGrid.className = "loom-profile-grid";
        [
            { path: "parameters.temperature", key: "profiles.temperature", label: "Temperature", type: "number", min: "0", max: "2", step: "0.05" },
            { path: "parameters.top_p", key: "profiles.top_p", label: "Top P", type: "number", min: "0", max: "1", step: "0.05" },
            { path: "parameters.max_tokens", key: "profiles.max_tokens", label: "Max tokens", type: "number", min: "1", max: String(profile.model_info?.output_limit || 1048576), step: "1" },
            { path: "parameters.reasoning_effort", key: "profiles.reasoning_effort", label: "Reasoning effort", type: "select", options: reasoningOptions(profile) },
            { path: "parameters.timeout", key: "profiles.timeout", label: "Timeout (seconds)", type: "number", min: "1", max: "3600", step: "1" },
            { path: "parameters.teacher_mode", key: "profiles.teacher_mode", label: "Teacher mode", type: "select", options: [["qwen-redact", "profiles.teacher_mode.qwen", "Qwen redaction"], ["regex", "profiles.teacher_mode.regex", "Placeholder redaction"]] }
        ].forEach(function (config) {
            const field = createInputField(panel, profile, config);
            if (config.path === "parameters.reasoning_effort") field.dataset.profileVisible = "reasoning_effort";
            if (config.path === "parameters.temperature") field.dataset.profileVisible = "temperature";
            generationGrid.appendChild(field);
        });
        generationGrid.appendChild(createSwitchField(panel, profile, "parameters.sanitize_sensitive", "profiles.sanitize_sensitive", "Sanitize sensitive content"));
        generation.appendChild(generationGrid);

        const local = section(t("profiles.section.local", "Local runtime"), "loom-profile-local", t("profiles.section.local.hint", "llama.cpp paths and hardware allocation for this model."));
        local.dataset.profileVisible = "local";
        const localGrid = document.createElement("div");
        localGrid.className = "loom-profile-grid";
        [
            { path: "model_path", key: "profiles.model_path", label: "Model path" },
            { path: "mmproj_path", key: "profiles.mmproj_path", label: "MMProj path" },
            { path: "llama_server_path", key: "profiles.llama_server_path", label: "llama-server path" },
            { path: "n_ctx", key: "profiles.n_ctx", label: "Context size", type: "number", min: "1024", max: "1048576", step: "1024" },
            { path: "n_gpu_layers", key: "profiles.n_gpu_layers", label: "GPU layers", type: "number", min: "-1", max: "10000", step: "1" }
        ].forEach(function (config) {
            const field = createInputField(panel, profile, config);
            if (config.path === "mmproj_path") field.dataset.profileVisible = "mmproj_path";
            localGrid.appendChild(field);
        });
        const thinking = createSwitchField(panel, profile, "thinking", "profiles.thinking", "Thinking");
        thinking.dataset.profileVisible = "thinking";
        localGrid.appendChild(thinking);
        local.appendChild(localGrid);
        advancedBody.append(basic, connection, capabilities, generation, local);
        const profileActions = panel.querySelector(".loom-profile-actions");
        if (profileActions) advancedBody.appendChild(profileActions);
        advanced.append(advancedSummary, advancedBody);
        editor.append(summary, quick, advanced);
        editor.querySelector('[data-profile-path="protocol"]').addEventListener("change", function () { renderModelProfileSettings(); });
        editor.querySelector('[data-profile-path="runtime"]').addEventListener("change", function () { renderModelProfileSettings(); });
        return editor;
    }

    function renderProfileList(panel, state) {
        const list = panel.querySelector("#loom_profile_list");
        if (!list) return;
        list.replaceChildren();
        state.profiles.forEach(function (profile) {
            const item = button("", "loom-profile-list-item");
            item.dataset.profileId = profile.id;
            item.setAttribute("role", "option");
            item.setAttribute("aria-selected", String(profile.id === selectedProfileId));
            if (profile.id === state.active_profile_id) item.classList.add("loom-profile-active");
            if (!profile.enabled) item.classList.add("loom-profile-disabled");
            const marker = document.createElement("span");
            marker.className = "loom-profile-active-marker";
            marker.textContent = "";
            marker.setAttribute("aria-label", profile.id === state.active_profile_id ? t("profiles.active", "Active") : "");
            const name = document.createElement("span");
            name.className = "loom-profile-list-name";
            name.textContent = profile.display_name;
            const meta = document.createElement("span");
            meta.className = "loom-profile-list-meta";
            meta.textContent = profile.model_id;
            item.append(marker, name, meta);
            item.addEventListener("click", function () { selectedProfileId = profile.id; renderModelProfileSettings(); });
            list.appendChild(item);
        });
        const count = panel.querySelector("#loom_profile_count");
        if (count) count.textContent = String(state.profiles.length);
    }

    function renderModelProfileSettings() {
        const panel = document.getElementById("loom_assistant_settings_panel");
        if (!panel || !tools.profileStore) return panel;
        const state = tools.profileStore.load();
        if (!state.profiles.some(function (profile) { return profile.id === selectedProfileId; })) selectedProfileId = state.active_profile_id;
        const profile = state.profiles.find(function (item) { return item.id === selectedProfileId; });
        renderProfileList(panel, state);
        const teacher = panel.querySelector("#loom_teacher_profile");
        teacher.replaceChildren();
        state.profiles.filter(function (item) { return item.enabled; }).forEach(function (item) {
            teacher.appendChild(option(item.id, item.display_name));
        });
        teacher.value = state.teacher_profile_id;
        const session = panel.querySelector("#loom_session_profile");
        session.replaceChildren();
        state.profiles.filter(function (item) { return item.enabled && ["llama-endpoint", "llama-once"].includes(item.runtime); }).forEach(function (item) {
            session.appendChild(option(item.id, item.display_name));
        });
        session.value = state.session_profile_id;
        session.disabled = !session.options.length;
        session.closest(".loom-profile-route-card")?.classList.toggle("loom-profile-route-unavailable", !session.options.length);
        const editorHost = panel.querySelector("#loom_profile_editor_host");
        editorHost.replaceChildren(createEditor(panel, state, profile));
        applyProfileVisibility(panel, profile);
        return panel;
    }

    async function testModelProfileConnection(id, panel, trigger) {
        const host = panel || document.getElementById("loom_assistant_settings_panel");
        const buttonElement = trigger || host?.querySelector(".loom-profile-test-row button");
        if (buttonElement) buttonElement.disabled = true;
        updateStatus(host, t("profiles.test.testing", "Testing connection..."), "pending");
        try {
            await tools.importAssistantProfiles?.(true);
            await tools.profileChat(id, [{ role: "user", content: t("profiles.test.ping", "Ping. Reply with OK.") }]);
            updateStatus(host, t("profiles.test.success", "Connection successful."), "success");
            return true;
        } catch (_error) {
            updateStatus(host, t("profiles.test.error", "Connection failed. Check the profile and try again."), "error");
            return false;
        } finally {
            if (buttonElement) buttonElement.disabled = false;
        }
    }

    function setupModelProfileSettingsWindow() {
        const existing = document.getElementById("loom_assistant_settings_panel");
        if (existing) return existing;
        if (!tools.profileStore) return null;
        const panel = document.createElement("div");
        panel.id = "loom_assistant_settings_panel";
        panel.className = "loom-profile-settings";
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-modal", "true");
        panel.setAttribute("aria-labelledby", "loom_profile_settings_title");
        const backdrop = document.createElement("div");
        backdrop.id = "loom_assistant_settings_backdrop";
        backdrop.className = "loom-profile-backdrop";
        backdrop.setAttribute("aria-hidden", "true");
        backdrop.addEventListener("pointerdown", function () { closeModelProfileSettings(panel); });

        const header = document.createElement("header");
        header.className = "loom-profile-head";
        const titleGroup = document.createElement("div");
        titleGroup.className = "loom-profile-title-group";
        const title = document.createElement("strong");
        title.id = "loom_profile_settings_title";
        title.textContent = t("profiles.title", "Model profiles");
        const status = document.createElement("span");
        status.id = "loom_profile_status";
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        status.textContent = t("profiles.status.autosave", "Changes save automatically");
        titleGroup.append(title, status);
        function routeControl(kind, key, fallback, hint, select) {
            const label = document.createElement("label");
            label.className = "loom-profile-route-card";
            label.dataset.route = kind;
            const copy = document.createElement("span");
            copy.className = "loom-profile-route-copy";
            const name = fieldLabel(key, fallback);
            const description = document.createElement("small");
            description.textContent = hint;
            copy.append(name, description);
            label.append(copy, select);
            return label;
        }
        const teacher = document.createElement("select");
        const teacherLabel = routeControl("teacher", "profiles.teacher_profile", "Teacher profile", t("profiles.route.teacher.hint", "Sanitizes context before remote requests"), teacher);
        teacher.id = "loom_teacher_profile";
        teacher.addEventListener("change", function () {
            tools.profileStore.setTeacher(teacher.value);
            updateStatus(panel, t("profiles.status.saved", "Saved"), "success");
            dispatchProfileChange(tools.profileStore.load());
            renderModelProfileSettings();
        });
        const session = document.createElement("select");
        const sessionLabel = routeControl("session", "profiles.session_profile", "Session title and summary", t("profiles.route.session.hint", "Names and summarizes saved sessions locally"), session);
        session.id = "loom_session_profile";
        session.addEventListener("change", function () {
            tools.profileStore.setSession(session.value);
            updateStatus(panel, t("profiles.status.saved", "Saved"), "success");
            dispatchProfileChange(tools.profileStore.load());
            renderModelProfileSettings();
        });
        const roleSelectors = document.createElement("div");
        roleSelectors.className = "loom-profile-role-selectors";
        const runtime = document.createElement("select");
        const runtimeControl = routeControl("runtime", "profiles.assistant_runtime", "Assistant runtime", t("profiles.route.runtime.hint", "Executes assistant sessions and tool calls"), runtime);
        runtime.id = "loom_assistant_runtime";
        const ktRuntime = document.createElement("option");
        ktRuntime.value = "kohaku-terrarium";
        ktRuntime.textContent = "KohakuTerrarium";
        runtime.appendChild(ktRuntime);
        runtime.value = tools.assistantRuntime?.() || "kohaku-terrarium";
        runtime.addEventListener("change", function () {
            try {
                tools.setAssistantRuntime?.(runtime.value);
                updateStatus(panel, t("profiles.status.saved", "Saved"), "success");
            } catch (error) {
                updateStatus(panel, String(error?.message || error), "error");
            }
        });
        roleSelectors.append(runtimeControl, teacherLabel, sessionLabel);
        const close = button("×", "loom-profile-close");
        close.title = t("profiles.close", "Close");
        close.setAttribute("aria-label", t("profiles.close", "Close"));
        close.addEventListener("click", function () { closeModelProfileSettings(panel); });
        header.append(titleGroup, close);

        const body = document.createElement("div");
        body.className = "loom-profile-layout";
        const sidebar = document.createElement("aside");
        sidebar.className = "loom-profile-sidebar";
        const sidebarHead = document.createElement("div");
        sidebarHead.className = "loom-profile-sidebar-head";
        const sidebarTitle = document.createElement("strong");
        sidebarTitle.textContent = t("profiles.fleet", "Model fleet");
        const profileCount = document.createElement("span");
        profileCount.id = "loom_profile_count";
        sidebarHead.append(sidebarTitle, profileCount);
        const list = document.createElement("div");
        list.id = "loom_profile_list";
        list.className = "loom-profile-list";
        list.setAttribute("role", "listbox");
        list.setAttribute("aria-label", t("profiles.list", "Model profiles"));
        const actions = document.createElement("div");
        actions.className = "loom-profile-actions";
        const add = button(t("profiles.add", "Add"), "loom-profile-add");
        const duplicate = button(t("profiles.duplicate", "Duplicate"), "loom-profile-duplicate");
        const remove = button(t("profiles.delete", "Delete"), "loom-profile-danger");
        const activate = button(t("profiles.set_active", "Set active"), "loom-profile-primary loom-profile-activate");
        const restore = button(t("profiles.restore", "Restore defaults"), "loom-profile-restore");
        add.id = "loom_profile_add";
        duplicate.id = "loom_profile_duplicate";
        remove.id = "loom_profile_delete";
        activate.id = "loom_profile_activate";
        restore.id = "loom_profile_restore";
        add.addEventListener("click", function () {
            const added = tools.profileStore.add({ display_name: t("profiles.new_name", "New profile"), model_id: t("profiles.new_model_id", "model") });
            selectedProfileId = added.id;
            dispatchProfileChange(tools.profileStore.load());
            renderModelProfileSettings();
        });
        duplicate.addEventListener("click", function () {
            const copy = tools.profileStore.duplicate(selectedProfileId);
            selectedProfileId = copy.id;
            dispatchProfileChange(tools.profileStore.load());
            renderModelProfileSettings();
        });
        remove.addEventListener("click", function () {
            if (!window.confirm(t("profiles.delete.confirm", "Delete this profile?"))) return;
            try {
                tools.profileStore.delete(selectedProfileId);
                const state = tools.profileStore.load();
                selectedProfileId = state.active_profile_id;
                dispatchProfileChange(state);
                renderModelProfileSettings();
            } catch (_error) {
                updateStatus(panel, t("profiles.delete.last_enabled", "At least one enabled profile is required."), "error");
            }
        });
        activate.addEventListener("click", function () {
            try {
                tools.profileStore.setActive(selectedProfileId);
                dispatchProfileChange(tools.profileStore.load());
                renderModelProfileSettings();
            } catch (_error) {
                updateStatus(panel, t("profiles.active.disabled", "Enable this profile before making it active."), "error");
            }
        });
        restore.addEventListener("click", function () {
            if (!window.confirm(t("profiles.restore.confirm", "Replace all profiles with the defaults?"))) return;
            const state = tools.profileStore.restoreDefaults();
            selectedProfileId = state.active_profile_id;
            dispatchProfileChange(state);
            renderModelProfileSettings();
        });
        actions.append(add, duplicate, remove, activate, restore);
        sidebar.append(sidebarHead, list, actions);
        const editorHost = document.createElement("main");
        editorHost.id = "loom_profile_editor_host";
        editorHost.className = "loom-profile-editor-host";
        body.append(sidebar, editorHost);
        panel.append(header, roleSelectors, body);
        document.body.append(backdrop, panel);

        list.addEventListener("keydown", function (event) {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            const items = Array.from(list.querySelectorAll("button"));
            if (!items.length) return;
            const current = Math.max(0, items.indexOf(document.activeElement));
            const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
            event.preventDefault();
            items[next].focus();
        });
        panel.addEventListener("keydown", function (event) {
            if (event.key === "Escape") {
                closeModelProfileSettings(panel);
                event.preventDefault();
                return;
            }
            if (event.key !== "Tab" || !panel.classList.contains("loom-config-open")) return;
            const focusable = Array.from(panel.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary"))
                .filter(function (element) {
                    if (element.closest("[hidden]")) return false;
                    const closedDetails = element.closest("details:not([open])");
                    return !closedDetails || element.tagName === "SUMMARY";
                });
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                last.focus();
                event.preventDefault();
            } else if (!event.shiftKey && document.activeElement === last) {
                first.focus();
                event.preventDefault();
            }
        });
        selectedProfileId = tools.profileStore.load().active_profile_id;
        return renderModelProfileSettings();
    }

    function openModelProfileSettings() {
        const panel = setupModelProfileSettingsWindow();
        if (!panel) return null;
        settingsReturnFocus = document.activeElement;
        renderModelProfileSettings();
        panel.classList.add("loom-config-open");
        document.getElementById("loom_assistant_settings_backdrop")?.classList.add("loom-config-open");
        window.requestAnimationFrame(function () {
            (panel.querySelector(".loom-profile-key-field input") || panel.querySelector(".loom-profile-list-item[aria-selected='true']"))?.focus();
        });
        return panel;
    }

    Object.assign(tools, {
        profileProtocolAbbreviation: protocolAbbreviation,
        profileSettingsVisibility: profileSettingsVisibility,
        profileWorkspaceTabs: profileWorkspaceTabs,
        profileRoleLabels: profileRoleLabels,
        profileReasoningOptions: reasoningOptions,
        buildModelProfileTestPayload: buildModelProfileTestPayload,
        setupModelProfileSettingsWindow: setupModelProfileSettingsWindow,
        openModelProfileSettings: openModelProfileSettings,
        renderModelProfileSettings: renderModelProfileSettings,
        testModelProfileConnection: testModelProfileConnection
    });
})();
