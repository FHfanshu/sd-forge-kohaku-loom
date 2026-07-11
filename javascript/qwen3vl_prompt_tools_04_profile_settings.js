(function () {
    const tools = window.q3vlPromptTools = window.q3vlPromptTools || {};
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
            reasoning_effort: Boolean(capabilities.reasoning)
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

    function section(title, className) {
        const element = document.createElement("section");
        element.className = `q3vl-profile-section ${className || ""}`.trim();
        const heading = document.createElement("h3");
        heading.textContent = title;
        element.appendChild(heading);
        return element;
    }

    function fieldLabel(key, fallback) {
        const label = document.createElement("span");
        label.className = "q3vl-profile-label";
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
        window.dispatchEvent(new CustomEvent("q3vl:model-profiles-changed", { detail: state }));
    }

    function updateStatus(panel, message, type) {
        const status = panel && panel.querySelector("#q3vl_profile_status");
        if (!status) return;
        status.textContent = message;
        status.dataset.status = type || "";
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
        label.className = "q3vl-profile-field";
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
        input.value = value;
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
            if (config.path === "runtime" && next !== "remote-http" && profile.protocol === "gemini-native") {
                patch.protocol = "openai-chat-completions";
            } else if (config.path === "protocol" && next === "gemini-native" && profile.runtime !== "remote-http") {
                patch.runtime = "remote-http";
            }
            const updated = persistPatch(panel, profile, patch);
            if (!updated) input.value = config.path === "fallback_endpoints" ? (profile.fallback_endpoints || []).join("\n") : fieldValue(profile, config.path);
            if (updated && config.path === "display_name") renderProfileList(panel, tools.profileStore.load());
        };
        if (!config.readOnly) {
            input.addEventListener(config.path === "api_key" || config.path === "display_name" ? "input" : "change", commit);
        }
        if (config.type === "password") {
            const secret = document.createElement("div");
            secret.className = "q3vl-profile-secret";
            secret.appendChild(input);
            const reveal = button(t("profiles.api_key.show", "Show"), "q3vl-profile-reveal");
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
        label.className = "q3vl-profile-switch";
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
        editor.className = "q3vl-profile-editor";

        const basic = section(t("profiles.section.basic", "Basic"));
        const basicGrid = document.createElement("div");
        basicGrid.className = "q3vl-profile-grid";
        [
            { path: "id", key: "profiles.id", label: "Profile ID", readOnly: true },
            { path: "display_name", key: "profiles.display_name", label: "Display name" },
            { path: "model_id", key: "profiles.model_id", label: "Model ID" },
            { path: "protocol", key: "profiles.protocol", label: "Protocol", type: "select", options: [["gemini-native", "profiles.protocol.gemini", "Gemini native"], ["openai-chat-completions", "profiles.protocol.openai", "OpenAI chat completions"]] },
            { path: "runtime", key: "profiles.runtime", label: "Runtime", type: "select", options: [["remote-http", "profiles.runtime.remote", "Remote HTTP"], ["llama-endpoint", "profiles.runtime.endpoint", "llama endpoint"], ["llama-once", "profiles.runtime.once", "llama once"]] }
        ].forEach(function (config) { basicGrid.appendChild(createInputField(panel, profile, config)); });
        basicGrid.appendChild(createSwitchField(panel, profile, "enabled", "profiles.enabled", "Enabled"));
        basic.appendChild(basicGrid);

        const connection = section(t("profiles.section.connection", "Connection"));
        const connectionGrid = document.createElement("div");
        connectionGrid.className = "q3vl-profile-grid";
        const endpoint = createInputField(panel, profile, { path: "endpoint", key: "profiles.endpoint", label: "Endpoint" });
        endpoint.dataset.profileVisible = "endpoint";
        const fallbacks = createInputField(panel, profile, { path: "fallback_endpoints", key: "profiles.fallback_endpoints", label: "Fallback endpoints", type: "textarea", rows: 3 });
        fallbacks.dataset.profileVisible = "fallback_endpoints";
        const apiKey = createInputField(panel, profile, { path: "api_key", key: "profiles.api_key", label: "API key", type: "password" });
        apiKey.dataset.profileVisible = "api_key";
        connectionGrid.append(endpoint, fallbacks, apiKey);
        const testRow = document.createElement("div");
        testRow.className = "q3vl-profile-test-row";
        const testButton = button(t("profiles.test", "Test connection"), "q3vl-profile-primary");
        testButton.disabled = !profile.enabled;
        testButton.addEventListener("click", function () { testModelProfileConnection(profile.id, panel, testButton); });
        testRow.appendChild(testButton);
        connection.append(connectionGrid, testRow);

        const capabilities = section(t("profiles.section.capabilities", "Capabilities"));
        const switchGrid = document.createElement("div");
        switchGrid.className = "q3vl-profile-switch-grid";
        [["tools", "Tools"], ["vision", "Vision"], ["streaming", "Streaming"], ["reasoning", "Reasoning"]].forEach(function (item) {
            switchGrid.appendChild(createSwitchField(panel, profile, `capabilities.${item[0]}`, `profiles.capability.${item[0]}`, item[1]));
        });
        capabilities.appendChild(switchGrid);

        const generation = section(t("profiles.section.generation", "Generation"));
        const generationGrid = document.createElement("div");
        generationGrid.className = "q3vl-profile-grid";
        [
            { path: "parameters.temperature", key: "profiles.temperature", label: "Temperature", type: "number", min: "0", max: "2", step: "0.05" },
            { path: "parameters.top_p", key: "profiles.top_p", label: "Top P", type: "number", min: "0", max: "1", step: "0.05" },
            { path: "parameters.max_tokens", key: "profiles.max_tokens", label: "Max tokens", type: "number", min: "1", max: "1048576", step: "1" },
            { path: "parameters.reasoning_effort", key: "profiles.reasoning_effort", label: "Reasoning effort", type: "select", options: [["low", "profiles.reasoning.low", "Low"], ["high", "profiles.reasoning.high", "High"], ["max", "profiles.reasoning.max", "Max"]] },
            { path: "parameters.timeout", key: "profiles.timeout", label: "Timeout (seconds)", type: "number", min: "1", max: "3600", step: "1" },
            { path: "parameters.teacher_mode", key: "profiles.teacher_mode", label: "Teacher mode", type: "select", options: [["qwen-redact", "profiles.teacher_mode.qwen", "Qwen redaction"], ["regex", "profiles.teacher_mode.regex", "Placeholder redaction"]] }
        ].forEach(function (config) {
            const field = createInputField(panel, profile, config);
            if (config.path === "parameters.reasoning_effort") field.dataset.profileVisible = "reasoning_effort";
            generationGrid.appendChild(field);
        });
        generationGrid.appendChild(createSwitchField(panel, profile, "parameters.sanitize_sensitive", "profiles.sanitize_sensitive", "Sanitize sensitive content"));
        generation.appendChild(generationGrid);

        const local = section(t("profiles.section.local", "Local runtime"), "q3vl-profile-local");
        local.dataset.profileVisible = "local";
        const localGrid = document.createElement("div");
        localGrid.className = "q3vl-profile-grid";
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

        editor.append(basic, connection, capabilities, generation, local);
        editor.querySelector('[data-profile-path="protocol"]').addEventListener("change", function () { renderModelProfileSettings(); });
        editor.querySelector('[data-profile-path="runtime"]').addEventListener("change", function () { renderModelProfileSettings(); });
        return editor;
    }

    function renderProfileList(panel, state) {
        const list = panel.querySelector("#q3vl_profile_list");
        if (!list) return;
        list.replaceChildren();
        state.profiles.forEach(function (profile) {
            const item = button("", "q3vl-profile-list-item");
            item.dataset.profileId = profile.id;
            item.setAttribute("role", "option");
            item.setAttribute("aria-selected", String(profile.id === selectedProfileId));
            if (profile.id === state.active_profile_id) item.classList.add("q3vl-profile-active");
            if (!profile.enabled) item.classList.add("q3vl-profile-disabled");
            const marker = document.createElement("span");
            marker.className = "q3vl-profile-active-marker";
            marker.textContent = profile.id === state.active_profile_id ? "●" : "";
            marker.setAttribute("aria-label", profile.id === state.active_profile_id ? t("profiles.active", "Active") : "");
            const name = document.createElement("span");
            name.className = "q3vl-profile-list-name";
            name.textContent = profile.display_name;
            const meta = document.createElement("span");
            meta.className = "q3vl-profile-list-meta";
            const protocol = profile.protocol === "gemini-native"
                ? t("profiles.protocol.abbr.gemini", protocolAbbreviation(profile.protocol))
                : t("profiles.protocol.abbr.openai", protocolAbbreviation(profile.protocol));
            meta.textContent = `${protocol} · ${profile.enabled ? t("profiles.enabled", "Enabled") : t("profiles.disabled", "Disabled")}`;
            item.append(marker, name, meta);
            item.addEventListener("click", function () { selectedProfileId = profile.id; renderModelProfileSettings(); });
            list.appendChild(item);
        });
    }

    function renderModelProfileSettings() {
        const panel = document.getElementById("q3vl_assistant_settings_panel");
        if (!panel || !tools.profileStore) return panel;
        const state = tools.profileStore.load();
        if (!state.profiles.some(function (profile) { return profile.id === selectedProfileId; })) selectedProfileId = state.active_profile_id;
        const profile = state.profiles.find(function (item) { return item.id === selectedProfileId; });
        renderProfileList(panel, state);
        const teacher = panel.querySelector("#q3vl_teacher_profile");
        teacher.replaceChildren();
        state.profiles.filter(function (item) { return item.enabled; }).forEach(function (item) {
            teacher.appendChild(option(item.id, item.display_name));
        });
        teacher.value = state.teacher_profile_id;
        const editorHost = panel.querySelector("#q3vl_profile_editor_host");
        editorHost.replaceChildren(createEditor(panel, state, profile));
        applyProfileVisibility(panel, profile);
        return panel;
    }

    async function testModelProfileConnection(id, panel, trigger) {
        const host = panel || document.getElementById("q3vl_assistant_settings_panel");
        const buttonElement = trigger || host?.querySelector(".q3vl-profile-test-row button");
        if (buttonElement) buttonElement.disabled = true;
        updateStatus(host, t("profiles.test.testing", "Testing connection..."), "pending");
        try {
            const projection = tools.profileStore.requestProjection(id);
            const payload = buildModelProfileTestPayload(projection, t("profiles.test.ping", "Ping. Reply with OK."));
            const response = await fetch("/qwen3vl-prompt-tools/assistant", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            if (!response.ok) throw new Error(String(response.status));
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
        const existing = document.getElementById("q3vl_assistant_settings_panel");
        if (existing) return existing;
        if (!tools.profileStore) return null;
        const panel = document.createElement("div");
        panel.id = "q3vl_assistant_settings_panel";
        panel.className = "q3vl-profile-settings";
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-modal", "true");
        panel.setAttribute("aria-labelledby", "q3vl_profile_settings_title");

        const header = document.createElement("header");
        header.className = "q3vl-profile-head";
        const titleGroup = document.createElement("div");
        const title = document.createElement("strong");
        title.id = "q3vl_profile_settings_title";
        title.textContent = t("profiles.title", "Model profiles");
        const status = document.createElement("span");
        status.id = "q3vl_profile_status";
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        status.textContent = t("profiles.status.autosave", "Changes save automatically");
        titleGroup.append(title, status);
        const teacherLabel = document.createElement("label");
        teacherLabel.className = "q3vl-profile-teacher";
        teacherLabel.appendChild(fieldLabel("profiles.teacher_profile", "Teacher profile"));
        const teacher = document.createElement("select");
        teacher.id = "q3vl_teacher_profile";
        teacher.addEventListener("change", function () {
            tools.profileStore.setTeacher(teacher.value);
            updateStatus(panel, t("profiles.status.saved", "Saved"), "success");
            dispatchProfileChange(tools.profileStore.load());
        });
        teacherLabel.appendChild(teacher);
        const close = button("×", "q3vl-profile-close");
        close.title = t("profiles.close", "Close");
        close.setAttribute("aria-label", t("profiles.close", "Close"));
        close.addEventListener("click", function () {
            panel.classList.remove("q3vl-config-open");
            settingsReturnFocus?.focus();
        });
        header.append(titleGroup, teacherLabel, close);

        const body = document.createElement("div");
        body.className = "q3vl-profile-layout";
        const sidebar = document.createElement("aside");
        sidebar.className = "q3vl-profile-sidebar";
        const list = document.createElement("div");
        list.id = "q3vl_profile_list";
        list.className = "q3vl-profile-list";
        list.setAttribute("role", "listbox");
        list.setAttribute("aria-label", t("profiles.list", "Model profiles"));
        const actions = document.createElement("div");
        actions.className = "q3vl-profile-actions";
        const add = button(t("profiles.add", "Add"));
        const duplicate = button(t("profiles.duplicate", "Duplicate"));
        const remove = button(t("profiles.delete", "Delete"), "q3vl-profile-danger");
        const activate = button(t("profiles.set_active", "Set active"), "q3vl-profile-primary");
        const restore = button(t("profiles.restore", "Restore defaults"));
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
        sidebar.append(list, actions);
        const editorHost = document.createElement("main");
        editorHost.id = "q3vl_profile_editor_host";
        editorHost.className = "q3vl-profile-editor-host";
        body.append(sidebar, editorHost);
        panel.append(header, body);
        document.body.appendChild(panel);

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
                panel.classList.remove("q3vl-config-open");
                settingsReturnFocus?.focus();
                event.preventDefault();
                return;
            }
            if (event.key !== "Tab" || !panel.classList.contains("q3vl-config-open")) return;
            const focusable = Array.from(panel.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)"))
                .filter(function (element) { return !element.closest("[hidden]"); });
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
        document.getElementById("q3vl_assistant_panel")?.classList.remove("q3vl-assistant-open");
        renderModelProfileSettings();
        panel.classList.add("q3vl-config-open");
        window.requestAnimationFrame(function () { panel.querySelector(".q3vl-profile-list-item[aria-selected='true']")?.focus(); });
        return panel;
    }

    Object.assign(tools, {
        profileProtocolAbbreviation: protocolAbbreviation,
        profileSettingsVisibility: profileSettingsVisibility,
        buildModelProfileTestPayload: buildModelProfileTestPayload,
        setupModelProfileSettingsWindow: setupModelProfileSettingsWindow,
        openModelProfileSettings: openModelProfileSettings,
        renderModelProfileSettings: renderModelProfileSettings,
        testModelProfileConnection: testModelProfileConnection
    });
})();
