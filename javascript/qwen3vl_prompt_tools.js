(function () {
    window.q3vlPromptTools = window.q3vlPromptTools || {};

    function q3vlApp() {
        const app = typeof gradioApp === "function" ? gradioApp() : null;
        return app || document;
    }

    function q3vlMainApp() {
        const app = q3vlApp();
        if (!app || typeof app.querySelector !== "function") return null;
        const hasMainTabs = !!app.querySelector("#tabs");
        const hasPromptBox = !!(app.querySelector("#txt2img_prompt") || app.querySelector("#img2img_prompt"));
        return hasMainTabs && hasPromptBox ? app : null;
    }

    function assistantPanel() {
        return document.getElementById("q3vl_assistant_panel");
    }

    function removeAssistantWindow() {
        document.querySelectorAll("#q3vl_assistant_launcher, #q3vl_assistant_panel").forEach(function (el) {
            el.remove();
        });
    }

    function currentForgePreset() {
        const preset = q3vlApp().querySelector("#forge_ui_preset");
        if (!preset) return "";

        const checked = preset.querySelector("input:checked");
        if (checked) return checked.value;

        const input = preset.querySelector("input");
        if (input) return input.value;

        const select = preset.querySelector("select");
        return select ? select.value : "";
    }

    function syncQwenPromptActions() {
        const visible = currentForgePreset() === "krea";
        q3vlApp().querySelectorAll(".q3vl-inline-actions").forEach(function (row) {
            row.classList.toggle("q3vl-hidden", !visible);
            row.querySelectorAll("button").forEach(function (button) {
                button.disabled = !visible;
                button.title = visible ? "" : "Qwen3-VL 扩写仅在 UI Preset = krea 时可用";
            });
        });
    }

    function setupQwenPresetGate() {
        syncQwenPromptActions();

        const preset = q3vlApp().querySelector("#forge_ui_preset");
        if (preset && !preset.dataset.q3vlPresetGate) {
            preset.dataset.q3vlPresetGate = "1";
            preset.addEventListener("change", syncQwenPromptActions, true);
            preset.addEventListener("input", syncQwenPromptActions, true);
            preset.addEventListener("click", function () {
                window.setTimeout(syncQwenPromptActions, 0);
            }, true);
        }
    }

    function textboxValue(root) {
        if (!root) return "";
        const textarea = root.querySelector("textarea");
        const input = root.querySelector("input");
        return textarea ? textarea.value : input ? input.value : "";
    }

    function setTextboxValue(root, value) {
        if (!root) return false;
        const target = root.querySelector("textarea") || root.querySelector("input");
        if (!target) return false;
        target.value = value;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    }

    function flashButton(root, text) {
        const button = root ? root.querySelector("button") || root : null;
        if (!button) return;
        const original = button.textContent;
        button.textContent = text;
        window.setTimeout(function () {
            button.textContent = original;
        }, 1100);
    }

    function switchMainTab(kind) {
        if (kind === "txt2img" && typeof switch_to_txt2img === "function") {
            switch_to_txt2img();
            return;
        }
        if (kind === "img2img" && typeof switch_to_img2img === "function") {
            switch_to_img2img();
            return;
        }
        const tabs = q3vlApp().querySelector("#tabs");
        const buttons = tabs ? tabs.querySelectorAll("button") : [];
        const index = kind === "txt2img" ? 0 : 1;
        if (buttons[index]) buttons[index].click();
    }

    function sendReversePrompt(kind) {
        const app = q3vlApp();
        const source = app.querySelector("#q3vl_reverse_output");
        const target = app.querySelector(kind === "txt2img" ? "#txt2img_prompt" : "#img2img_prompt");
        const value = textboxValue(source).trim();
        if (!value) return;
        if (setTextboxValue(target, value)) {
            switchMainTab(kind);
        }
    }

    function setupSendButtons() {
        const app = q3vlApp();
        const txt = app.querySelector("#q3vl_send_txt2img");
        const img = app.querySelector("#q3vl_send_img2img");
        if (txt && !txt.dataset.q3vlSendBound) {
            txt.dataset.q3vlSendBound = "1";
            txt.addEventListener("click", function () {
                window.setTimeout(function () {
                    sendReversePrompt("txt2img");
                    flashButton(txt, "已发送");
                }, 0);
            }, true);
        }
        if (img && !img.dataset.q3vlSendBound) {
            img.dataset.q3vlSendBound = "1";
            img.addEventListener("click", function () {
                window.setTimeout(function () {
                    sendReversePrompt("img2img");
                    flashButton(img, "已发送");
                }, 0);
            }, true);
        }
    }

    const assistantState = {
        messages: [],
        attachment: null,
        promptReads: {},
        promptStyles: null,
        apiKeyBackend: "moyuu"
    };

    const q3vlVisionPresets = {
        "Gemma 4 12B": "gemma-4-12b-it",
        "Qwen3.5 原版 9B": "qwen3.5-9b-vlm",
        "Qwen3.5 破限版 9B": "hauhau-qwen3.5-9b-uncensored",
        "自定义": ""
    };

    function defaultVisionPreset() {
        return "Qwen3.5 破限版 9B";
    }

    function visionModelForPreset(preset) {
        if (Object.prototype.hasOwnProperty.call(q3vlVisionPresets, preset)) return q3vlVisionPresets[preset];
        return q3vlVisionPresets[defaultVisionPreset()] || "local-vlm";
    }

    function configBool(value) {
        return ["1", "true", "yes", "on", "enabled"].includes(String(value || "").trim().toLowerCase());
    }

    const MOYUU_ASSISTANT_ENDPOINT = "https://moyuu.cc";
    const MOYUU_ASSISTANT_FALLBACK_ENDPOINT = "https://hk-api.moyuu.cc";
    const MOYUU_ASSISTANT_MODEL = "gemini-3.1-pro-high";
    const DEEPSEEK_ASSISTANT_ENDPOINT = "https://api.deepseek.com";
    const DEEPSEEK_ASSISTANT_MODEL = "deepseek-v4-pro";
    const KNOWN_ASSISTANT_ENDPOINTS = [MOYUU_ASSISTANT_ENDPOINT, MOYUU_ASSISTANT_FALLBACK_ENDPOINT, DEEPSEEK_ASSISTANT_ENDPOINT];
    const KNOWN_ASSISTANT_MODELS = [MOYUU_ASSISTANT_MODEL, DEEPSEEK_ASSISTANT_MODEL, "deepseekv4-pro", "deepseek-chat", "deepseek-reasoner"];

    function assistantApiKeyBackend(backend) {
        return backend === "deepseek" || backend === "local-lmcpp" || backend === "local-qwen-once" ? backend : "moyuu";
    }

    function assistantApiKeyStorageKey(backend) {
        return `q3vl_assistant_api_key_${assistantApiKeyBackend(backend)}`;
    }

    function storedAssistantApiKey(backend) {
        return localStorage.getItem(assistantApiKeyStorageKey(backend)) || localStorage.getItem("q3vl_assistant_api_key") || "";
    }

    function currentAssistantApiKey(panel, backend) {
        const input = panel?.querySelector('[data-q3vl-setting="api_key"]');
        if (input && assistantApiKeyBackend(backend) === assistantState.apiKeyBackend) return input.value || "";
        return storedAssistantApiKey(backend);
    }

    function storeAssistantApiKey(panel, backend) {
        const input = panel?.querySelector('[data-q3vl-setting="api_key"]');
        if (!input) return;
        localStorage.setItem(assistantApiKeyStorageKey(backend), input.value || "");
    }

    function loadAssistantApiKey(panel, backend) {
        const input = panel?.querySelector('[data-q3vl-setting="api_key"]');
        if (!input) return;
        assistantState.apiKeyBackend = assistantApiKeyBackend(backend);
        input.value = storedAssistantApiKey(backend);
        input.placeholder = backend === "deepseek" ? "DeepSeek API key" : backend === "local-lmcpp" || backend === "local-qwen-once" ? "本地后端无需 API key" : "Moyuu API key";
    }

    function assistantConfig() {
        const panel = assistantPanel();
        const get = function (name, fallback) {
            const value = panel ? panel.querySelector(`[data-q3vl-setting="${name}"]`)?.value : localStorage.getItem(`q3vl_assistant_${name}`);
            return value || fallback;
        };
        const endpoint = get("endpoint", MOYUU_ASSISTANT_ENDPOINT);
        const visionPreset = get("vision_preset", defaultVisionPreset());
        const backend = get("backend", "moyuu");
        return {
            backend: backend,
            endpoint: endpoint,
            fallback_endpoint: get("fallback_endpoint", MOYUU_ASSISTANT_FALLBACK_ENDPOINT),
            model: normalizeAssistantModel(endpoint, get("model", MOYUU_ASSISTANT_MODEL)),
            api_key: currentAssistantApiKey(panel, backend),
            local_endpoint: get("local_endpoint", "http://127.0.0.1:8080/v1"),
            local_model: get("local_model", "hauhau-qwen3.5-9b-uncensored"),
            vision_preset: visionPreset,
            vision_endpoint: get("vision_endpoint", "http://127.0.0.1:8080/v1"),
            vision_model: get("vision_model", visionModelForPreset(visionPreset)),
            vision_model_path: get("vision_model_path", ""),
            vision_mmproj_path: get("vision_mmproj_path", ""),
            vision_thinking: configBool(get("vision_thinking", "0")),
            sanitize_sensitive: configBool(get("sanitize_sensitive", "1")),
            teacher_mode: get("teacher_mode", "qwen-redact"),
            temperature: 0.35,
            top_p: 0.9,
            max_tokens: normalizeAssistantMaxTokens(get("max_tokens", "8192")),
            reasoning_effort: get("reasoning_effort", "high"),
            timeout: 120
        };
    }

    function normalizeAssistantModel(endpoint, model) {
        const cleaned = String(model || "").trim() || MOYUU_ASSISTANT_MODEL;
        try {
            const url = new URL(String(endpoint || ""));
            if (url.hostname === "api.deepseek.com" && cleaned === "deepseekv4-pro") return "deepseek-v4-pro";
            if (url.hostname === "api.deepseek.com" && cleaned === "deepseek-chat") return "deepseek-v4-pro";
            if (url.hostname === "api.deepseek.com" && cleaned === "deepseek-reasoner") return "deepseek-v4-pro";
            if ((url.hostname === "moyuu.cc" || url.hostname.endsWith(".moyuu.cc")) && KNOWN_ASSISTANT_MODELS.includes(cleaned) && cleaned !== MOYUU_ASSISTANT_MODEL) return MOYUU_ASSISTANT_MODEL;
        } catch (_error) { }
        return cleaned;
    }

    function defaultAssistantEndpointForBackend(backend) {
        return backend === "deepseek" ? DEEPSEEK_ASSISTANT_ENDPOINT : MOYUU_ASSISTANT_ENDPOINT;
    }

    function defaultAssistantModelForBackend(backend) {
        return backend === "deepseek" ? DEEPSEEK_ASSISTANT_MODEL : MOYUU_ASSISTANT_MODEL;
    }

    function storedAssistantEndpoint() {
        const stored = localStorage.getItem("q3vl_assistant_endpoint");
        return !stored || stored === DEEPSEEK_ASSISTANT_ENDPOINT ? MOYUU_ASSISTANT_ENDPOINT : stored;
    }

    function storedAssistantModel(endpoint) {
        const stored = localStorage.getItem("q3vl_assistant_model");
        const model = !stored || (KNOWN_ASSISTANT_ENDPOINTS.includes(endpoint) && KNOWN_ASSISTANT_MODELS.includes(stored)) ? MOYUU_ASSISTANT_MODEL : stored;
        return normalizeAssistantModel(endpoint, model);
    }

    function syncAssistantBackendDefaults(panel) {
        const backend = panel.querySelector('[data-q3vl-setting="backend"]')?.value || "moyuu";
        const endpointInput = panel.querySelector('[data-q3vl-setting="endpoint"]');
        const modelInput = panel.querySelector('[data-q3vl-setting="model"]');
        if (!endpointInput || !modelInput) return;
        if (!endpointInput.value || KNOWN_ASSISTANT_ENDPOINTS.includes(endpointInput.value)) {
            endpointInput.value = defaultAssistantEndpointForBackend(backend);
        }
        if (!modelInput.value || KNOWN_ASSISTANT_MODELS.includes(modelInput.value)) {
            modelInput.value = defaultAssistantModelForBackend(backend);
        }
    }

    function normalizeAssistantMaxTokens(value) {
        const parsed = Number.parseInt(String(value || ""), 10);
        if (!Number.isFinite(parsed) || parsed < 512) return 8192;
        return Math.min(parsed, 65536);
    }

    function saveAssistantConfig() {
        const panel = assistantPanel();
        if (!panel) return;
        storeAssistantApiKey(panel, assistantState.apiKeyBackend);
        panel.querySelectorAll("[data-q3vl-setting]").forEach(function (input) {
            if (input.dataset.q3vlSetting === "api_key") return;
            localStorage.setItem(`q3vl_assistant_${input.dataset.q3vlSetting}`, input.value || "");
        });
    }

    function setAssistantSettingsVisibility(panel) {
        if (!panel) return;
        const backend = panel.querySelector('[data-q3vl-setting="backend"]')?.value || "moyuu";
        const visionPreset = panel.querySelector('[data-q3vl-setting="vision_preset"]')?.value || defaultVisionPreset();
        const teacherMode = panel.querySelector('[data-q3vl-setting="teacher_mode"]')?.value || "qwen-redact";
        const localEndpoint = backend === "local-lmcpp";
        const localText = localEndpoint || backend === "local-qwen-once";
        const localVision = backend !== "moyuu" || (backend === "moyuu" && teacherMode === "qwen-redact");
        panel.querySelector('[data-q3vl-setting="api_key"]')?.toggleAttribute("hidden", localText);
        panel.querySelector('[data-q3vl-setting="api_key"]')?.toggleAttribute("disabled", localText);
        panel.querySelectorAll('[data-q3vl-field="remote"]').forEach(function (element) {
            element.hidden = localText;
        });
        panel.querySelectorAll('[data-q3vl-field="local-text"]').forEach(function (element) {
            element.hidden = !localEndpoint;
        });
        panel.querySelectorAll('[data-q3vl-field="local-vision"], [data-q3vl-field="vision-advanced"]').forEach(function (element) {
            element.hidden = !localVision;
        });
        panel.querySelectorAll('[data-q3vl-field="vision-custom"]').forEach(function (element) {
            element.hidden = !localVision || visionPreset !== "自定义";
        });
    }

    function activePromptTarget() {
        const tabs = q3vlApp().querySelector("#tabs");
        const selected = tabs ? Array.from(tabs.querySelectorAll("button")).find(function (button) {
            return button.getAttribute("aria-selected") === "true" || button.classList.contains("selected");
        }) : null;
        const text = selected ? selected.textContent.toLowerCase() : "";
        return text.includes("img2img") ? "img2img" : "txt2img";
    }

    function promptRootForTarget(target) {
        const resolved = target === "active" || !target ? activePromptTarget() : target;
        return {
            target: resolved,
            root: q3vlApp().querySelector(resolved === "img2img" ? "#img2img_prompt" : "#txt2img_prompt")
        };
    }

    function normalizedLabelText(value) {
        return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    }

    function visibleText(node) {
        return String(node && node.textContent ? node.textContent : "").replace(/\s+/g, " ").trim();
    }

    function styleSelectorValue(target) {
        const app = q3vlApp();
        const resolved = target === "img2img" ? "img2img" : "txt2img";
        const root = app.querySelector(`#${resolved}_styles`);
        if (!root) return "";

        const input = root.querySelector("label > div input, input[autocomplete='off'], input[role='combobox'], input:not([type]), textarea");
        const inputValue = input && String(input.value || "").trim();
        if (inputValue) return inputValue;

        const ignored = new Set(["styles", "style", "风格", "风格模板", "风格模版", ""]);
        const candidates = [];
        root.querySelectorAll("[data-testid='selected-option'], [data-testid='token'], .token, .selected, button, span").forEach(function (node) {
            const text = normalizedLabelText(node.textContent);
            if (!ignored.has(text)) candidates.push(visibleText(node));
        });
        if (candidates.length) return Array.from(new Set(candidates)).join(", ");

        const text = visibleText(root)
            .replace(/^styles?\s*/i, "")
            .replace(/^风格(?:模板|模版)?\s*/, "")
            .trim();
        return ignored.has(normalizedLabelText(text)) ? "" : text;
    }

    async function promptStyles() {
        if (Array.isArray(assistantState.promptStyles)) return assistantState.promptStyles;
        const endpoints = ["/qwen3vl-prompt-tools/prompt-styles", "/sdapi/v1/prompt-styles"];
        for (const endpoint of endpoints) {
            try {
                const response = await fetch(endpoint);
                if (!response.ok) continue;
                const data = await response.json();
                const styles = Array.isArray(data) ? data : data.styles;
                if (Array.isArray(styles)) {
                    assistantState.promptStyles = styles.filter(function (style) { return style && style.name; });
                    return assistantState.promptStyles;
                }
            } catch (_error) { }
        }
        assistantState.promptStyles = [];
        return assistantState.promptStyles;
    }

    function selectedStyleDetails(selector, styles) {
        const selected = String(selector || "").trim();
        if (!selected || !Array.isArray(styles) || !styles.length) return [];
        const ignored = new Set(["none", "styles", "style", "风格", "风格模板", "风格模版", ""]);
        const byName = new Map();
        styles.forEach(function (style) {
            byName.set(normalizedLabelText(style.name), style);
        });

        const parts = selected.split(/[,\n]/).map(function (part) { return normalizedLabelText(part); }).filter(Boolean);
        const matches = [];
        parts.forEach(function (part) {
            const style = byName.get(part);
            if (style && !ignored.has(part)) matches.push(style);
        });
        if (!matches.length) {
            const normalizedSelected = normalizedLabelText(selected);
            styles.forEach(function (style) {
                const name = normalizedLabelText(style.name);
                if (!ignored.has(name) && normalizedSelected.includes(name)) matches.push(style);
            });
        }
        return Array.from(new Map(matches.map(function (style) { return [style.name, style]; })).values());
    }

    function styleDetailsText(details) {
        if (!details.length) return "";
        return details.map(function (style) {
            const lines = [`Style ${style.name}:`];
            if (style.prompt) lines.push(`positive: ${style.prompt}`);
            if (style.negative_prompt) lines.push(`negative: ${style.negative_prompt}`);
            return lines.join("\n");
        }).join("\n\n");
    }

    function styleTemplateRoot() {
        const app = q3vlApp();
        const direct = app.querySelector(
            "#setting_neta_template_positive, #neta_template_positive, #txt2img_style_template, #img2img_style_template"
        );
        if (direct && (direct.querySelector("textarea") || direct.querySelector("input"))) return direct;

        const labelNeedles = [
            "风格模版",
            "风格模板",
            "style template",
            "positive template",
            "trigger template",
            "触发词"
        ].map(normalizedLabelText);
        const labels = Array.from(app.querySelectorAll('[data-testid="block-info"], label, span'));
        for (const label of labels) {
            const text = normalizedLabelText(label.textContent);
            if (!text || !labelNeedles.some(function (needle) { return text.includes(needle); })) continue;
            let node = label.parentElement;
            for (let i = 0; i < 8 && node && node !== document.body; i += 1) {
                if (node.id === "txt2img_styles" || node.id === "img2img_styles") break;
                const control = node.querySelector("textarea, input");
                if (control && !control.closest("#q3vl_assistant_panel")) return node;
                node = node.parentElement;
            }
        }
        return null;
    }

    async function styleTemplateInfo(target) {
        const root = styleTemplateRoot();
        const selector = styleSelectorValue(target);
        const selectedStyles = selectedStyleDetails(selector, await promptStyles());
        const styleDetails = styleDetailsText(selectedStyles);
        const forgeTemplate = root ? textboxValue(root) : optionValue("neta_template_positive");
        const pieces = [];
        if (selector) pieces.push(`Selected WebUI Styles: ${selector}`);
        if (styleDetails) pieces.push(styleDetails);
        if (forgeTemplate) pieces.push(`Forge neta_template_positive: ${forgeTemplate}`);
        const template = pieces.join("\n\n");
        return {
            found: !!String(template || ""),
            template: template || "",
            style_selector: selector || "",
            selected_styles: selectedStyles.map(function (style) {
                return {
                    name: style.name || "",
                    prompt: style.prompt || "",
                    negative_prompt: style.negative_prompt || ""
                };
            }),
            forge_positive_template: forgeTemplate || ""
        };
    }

    function optionValue(key) {
        if (typeof opts !== "undefined" && opts && Object.prototype.hasOwnProperty.call(opts, key)) {
            return opts[key];
        }
        const settings = q3vlApp().querySelector("#settings_json textarea, #settings_json input");
        if (settings && settings.value) {
            try {
                const parsed = JSON.parse(settings.value);
                if (Object.prototype.hasOwnProperty.call(parsed, key)) return parsed[key];
            } catch (_error) { }
        }
        return "";
    }

    function promptHash(text) {
        let hash = 2166136261;
        const value = String(text || "");
        for (let i = 0; i < value.length; i += 1) {
            hash ^= value.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}:${value.length}`;
    }

    async function readPromptTool(target) {
        const item = promptRootForTarget(target || "active");
        const prompt = textboxValue(item.root);
        const hash = promptHash(prompt);
        const template = await styleTemplateInfo(item.target);
        assistantState.promptReads[item.target] = {
            hash: hash,
            prompt: prompt,
            at: Date.now()
        };
        return {
            ok: true,
            target: item.target,
            prompt: prompt,
            prompt_hash: hash,
            style_template_found: template.found,
            style_template: template.template,
            style_selector: template.style_selector,
            selected_styles: template.selected_styles,
            forge_positive_template: template.forge_positive_template
        };
    }

    function normalizePatchSeparator(value) {
        if (value === "space") return " ";
        if (value === "newline") return "\n";
        if (value === "double_newline") return "\n\n";
        return String(value ?? "");
    }

    function applyPromptPatchText(text, patch) {
        const operation = String(patch.operation || patch.op || "replace").trim();
        const find = String(patch.find ?? patch.old ?? "");
        const replacement = String(patch.replace ?? patch.replacement ?? patch.text ?? "");
        const separator = normalizePatchSeparator(patch.separator ?? "");
        const count = Number.isFinite(Number(patch.count)) ? Math.max(0, Number(patch.count)) : 1;

        if (operation === "append") {
            return { ok: true, text: text ? text + separator + replacement : replacement, changed: text ? 1 : Number(Boolean(replacement)) };
        }
        if (operation === "prepend") {
            return { ok: true, text: text ? replacement + separator + text : replacement, changed: text ? 1 : Number(Boolean(replacement)) };
        }
        if (operation === "delete") {
            if (!find) return { ok: false, error: "delete requires find text", text: text };
            if (!text.includes(find)) return { ok: false, error: "find text not found", text: text };
            const next = text.replace(find, "");
            return { ok: true, text: next, changed: 1 };
        }
        if (operation === "insert_after" || operation === "insert_before") {
            if (!find) return { ok: false, error: `${operation} requires find text`, text: text };
            const first = text.indexOf(find);
            if (first < 0) return { ok: false, error: "find text not found", text: text };
            const second = text.indexOf(find, first + find.length);
            if (second >= 0 && !patch.allow_multiple) return { ok: false, error: "find text is not unique; use a longer find string", text: text };
            if (second >= 0 && patch.allow_multiple) {
                const insertText = operation === "insert_after" ? find + separator + replacement : replacement + separator + find;
                const parts = text.split(find);
                return { ok: true, text: parts.join(insertText), changed: parts.length - 1 };
            }
            const insertAt = operation === "insert_after" ? first + find.length : first;
            const insertText = operation === "insert_after" ? separator + replacement : replacement + separator;
            return { ok: true, text: text.slice(0, insertAt) + insertText + text.slice(insertAt), changed: 1 };
        }
        if (operation === "replace_all") {
            if (!find) return { ok: false, error: "replace_all requires find text", text: text };
            if (!text.includes(find)) return { ok: false, error: "find text not found", text: text };
            const parts = text.split(find);
            return { ok: true, text: parts.join(replacement), changed: parts.length - 1 };
        }
        if (operation === "replace_n") {
            if (!find) return { ok: false, error: "replace_n requires find text", text: text };
            if (!text.includes(find)) return { ok: false, error: "find text not found", text: text };
            let changed = 0;
            let next = text;
            while (changed < count && next.includes(find)) {
                next = next.replace(find, replacement);
                changed += 1;
            }
            return { ok: true, text: next, changed: changed };
        }
        if (operation === "replace") {
            if (!find) return { ok: false, error: "replace requires find text", text: text };
            const first = text.indexOf(find);
            if (first < 0) return { ok: false, error: "find text not found", text: text };
            const second = text.indexOf(find, first + find.length);
            if (second >= 0 && !patch.allow_multiple) return { ok: false, error: "find text is not unique; use replace_all, replace_n, or a longer find string", text: text };
            return { ok: true, text: text.slice(0, first) + replacement + text.slice(first + find.length), changed: 1 };
        }
        return { ok: false, error: `unknown patch operation: ${operation}`, text: text };
    }

    function normalizeDiffText(diff) {
        if (Array.isArray(diff)) return diff.join("\n").replace(/\r\n?/g, "\n");
        return String(diff || "").replace(/\r\n?/g, "\n");
    }

    function patchesFromSearchReplaceBlocks(diff) {
        const patches = [];
        const pattern = /<<<<<<< SEARCH\s*\n([\s\S]*?)\n=======\s*\n([\s\S]*?)\n>>>>>>> REPLACE/g;
        let match;
        while ((match = pattern.exec(diff)) !== null) {
            patches.push({ operation: "replace", find: match[1], replace: match[2] });
        }
        return patches;
    }

    function patchesFromUnifiedDiff(diff) {
        const patches = [];
        const lines = diff.split("\n");
        let removed = [];
        let added = [];

        function flush() {
            if (removed.length || added.length) {
                patches.push({ operation: "replace", find: removed.join("\n"), replace: added.join("\n") });
                removed = [];
                added = [];
            }
        }

        for (const line of lines) {
            if (line.startsWith("---") || line.startsWith("+++")) continue;
            if (line.startsWith("@@")) {
                flush();
                continue;
            }
            if (line.startsWith("-")) {
                removed.push(line.slice(1));
                continue;
            }
            if (line.startsWith("+")) {
                added.push(line.slice(1));
                continue;
            }
            flush();
        }
        flush();
        return patches.filter(function (patch) { return patch.find || patch.replace; });
    }

    function patchesFromDiff(diff) {
        const text = normalizeDiffText(diff).trim();
        if (!text) return [];
        const searchReplace = patchesFromSearchReplaceBlocks(text);
        if (searchReplace.length) return searchReplace;
        return patchesFromUnifiedDiff(text);
    }

    function promptPatchResidue(text) {
        const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
        const matches = [];
        const patterns = [
            /\bgit diff\b/i,
            /\bdiff --git\b/i,
            /^\s*index [0-9a-f]{6,}\.\.[0-9a-f]{6,}/i,
            /^\s*(?:---|\+\+\+)\s+(?:a\/|b\/|\/dev\/null)/,
            /^\s*@@\s+[-+0-9, ]+@@/,
            /^\s*<<<<<<<\s*(?:SEARCH|HEAD|[\w.-]+)\b/,
            /^\s*=======\s*$/,
            /^\s*>>>>>>>\s*(?:REPLACE|[\w.-]+)\b/,
            /^\s*```\s*(?:diff|patch)\b/i
        ];
        lines.forEach(function (line, index) {
            if (patterns.some(function (pattern) { return pattern.test(line); })) {
                matches.push({ line: index + 1, text: line.slice(0, 120) });
            }
        });
        return matches;
    }

    function patchPromptRoot(root, patches, baseHash) {
        if (!root) return { ok: false, error: "prompt field not found", prompt: "" };
        const target = root.querySelector("textarea") || root.querySelector("input");
        if (!target) return { ok: false, error: "prompt input not found", prompt: "" };
        const current = target.value || "";
        const currentHash = promptHash(current);
        if (!baseHash) return { ok: false, error: "edit requires base_hash from read_prompt", prompt: current };
        if (currentHash !== baseHash) {
            return { ok: false, error: "prompt changed since read_prompt; read again before editing", prompt: current, current_hash: currentHash };
        }
        const list = Array.isArray(patches) ? patches : [patches];
        if (!list.length) return { ok: false, error: "no patches provided", prompt: current };
        let next = current;
        const results = [];
        for (let i = 0; i < list.length; i += 1) {
            const result = applyPromptPatchText(next, list[i] || {});
            results.push({ index: i, ok: result.ok, error: result.error || "", changed: result.changed || 0 });
            if (!result.ok) {
                return { ok: false, error: result.error, failed_index: i, results: results, prompt: next };
            }
            next = result.text;
        }
        const residue = promptPatchResidue(next);
        if (residue.length) {
            return {
                ok: false,
                error: "refusing to write prompt: final prompt contains git diff/patch residue. Regenerate clean prompt text only; use diff syntax only inside edit_prompt arguments.",
                residue: residue,
                prompt: current,
                attempted_prompt_preview: truncateAssistantText(next, 500)
            };
        }
        setNativeValueIfAvailable(target, next);
        return { ok: true, results: results, prompt: next, prompt_hash: promptHash(next) };
    }

    function setNativeValueIfAvailable(target, value) {
        const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
        if (descriptor && descriptor.set) descriptor.set.call(target, value);
        else target.value = value;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    }

    function compactPromptPatchResult(result, returnPrompt) {
        const next = Object.assign({}, result);
        if (typeof next.prompt === "string") {
            next.prompt_length = next.prompt.length;
            next.prompt_preview = truncateAssistantText(next.prompt, 500);
            if (!returnPrompt) delete next.prompt;
        }
        return next;
    }

    function editPromptTool(args, patches) {
        const item = promptRootForTarget(args.target || "active");
        const readState = assistantState.promptReads[item.target];
        const baseHash = String(args.base_hash || args.prompt_hash || "").trim();
        const patchList = args.diff !== undefined ? patchesFromDiff(args.diff) : patches;
        if (!readState) {
            return { ok: false, target: item.target, error: "must call read_prompt for this target before edit_prompt" };
        }
        if (!baseHash) {
            return { ok: false, target: item.target, error: "edit_prompt requires base_hash from read_prompt", last_read_hash: readState.hash };
        }
        if (baseHash !== readState.hash) {
            return { ok: false, target: item.target, error: "base_hash does not match the latest read_prompt result; read again", last_read_hash: readState.hash };
        }
        if (!Array.isArray(patchList) || !patchList.length) {
            return { ok: false, target: item.target, error: "edit_prompt requires diff or patches" };
        }
        const result = compactPromptPatchResult(patchPromptRoot(item.root, patchList, baseHash), Boolean(args.return_prompt));
        if (result.ok) {
            switchMainTab(item.target);
            assistantState.promptReads[item.target] = {
                hash: result.prompt_hash,
                prompt: result.prompt || "",
                at: Date.now()
            };
        }
        return Object.assign({ target: item.target }, result);
    }

    async function askTeacherTool(args) {
        const config = assistantConfig();
        const payload = Object.assign({}, config, args || {}, {
            backend: "moyuu",
            api_key: storedAssistantApiKey("moyuu") || config.api_key,
            endpoint: config.endpoint || MOYUU_ASSISTANT_ENDPOINT,
            fallback_endpoint: config.fallback_endpoint || MOYUU_ASSISTANT_FALLBACK_ENDPOINT,
            model: config.model || MOYUU_ASSISTANT_MODEL,
            question: String(args?.question || args?.prompt || args?.query || ""),
            context: String(args?.context || args?.briefing || ""),
            teacher_mode: "regex"
        });
        const response = await fetch("/qwen3vl-prompt-tools/ask-teacher", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const detail = await response.text();
            return { ok: false, error: detail };
        }
        return await response.json();
    }

    async function executeAssistantTool(tool) {
        const name = tool.tool || tool.name;
        const args = tool.arguments || {};
        if (name === "ask_teacher") {
            return await askTeacherTool(args);
        }
        if (name === "read_prompt" || name === "get_current_prompt") {
            return await readPromptTool(args.target || "active");
        }
        if (name === "edit_prompt") {
            return editPromptTool(args, args.patches || args.patch || []);
        }
        if (name === "set_current_prompt") {
            return { ok: false, error: "set_current_prompt is disabled to prevent prompt loss. Use read_prompt, then edit_prompt with base_hash and patches." };
        }
        if (name === "patch_current_prompt") {
            return editPromptTool(args, args.patch || args);
        }
        if (name === "multi_patch_current_prompt") {
            return editPromptTool(args, args.patches || []);
        }
        if (name === "get_style_template") {
            return { ok: false, error: "get_style_template is disabled. Use read_prompt; it returns style_template when available." };
        }
        if (name === "set_style_template") {
            return { ok: false, error: "set_style_template is disabled to avoid blind overwrites. Use read_prompt and edit the normal prompt with edit_prompt." };
        }
        return { ok: false, error: `unknown tool: ${name}` };
    }

    function truncateAssistantText(text, limit) {
        const value = String(text || "").trim();
        return value.length > limit ? `${value.slice(0, limit)}...` : value;
    }

    Object.assign(window.q3vlPromptTools, {
        q3vlApp,
        q3vlMainApp,
        assistantPanel,
        removeAssistantWindow,
        currentForgePreset,
        syncQwenPromptActions,
        setupQwenPresetGate,
        textboxValue,
        setTextboxValue,
        flashButton,
        switchMainTab,
        sendReversePrompt,
        setupSendButtons,
        assistantState,
        q3vlVisionPresets,
        defaultVisionPreset,
        visionModelForPreset,
        configBool,
        MOYUU_ASSISTANT_ENDPOINT,
        MOYUU_ASSISTANT_FALLBACK_ENDPOINT,
        MOYUU_ASSISTANT_MODEL,
        DEEPSEEK_ASSISTANT_ENDPOINT,
        DEEPSEEK_ASSISTANT_MODEL,
        KNOWN_ASSISTANT_ENDPOINTS,
        KNOWN_ASSISTANT_MODELS,
        assistantApiKeyBackend,
        assistantApiKeyStorageKey,
        storedAssistantApiKey,
        currentAssistantApiKey,
        storeAssistantApiKey,
        loadAssistantApiKey,
        assistantConfig,
        normalizeAssistantModel,
        defaultAssistantEndpointForBackend,
        defaultAssistantModelForBackend,
        storedAssistantEndpoint,
        storedAssistantModel,
        syncAssistantBackendDefaults,
        normalizeAssistantMaxTokens,
        saveAssistantConfig,
        setAssistantSettingsVisibility,
        activePromptTarget,
        promptRootForTarget,
        normalizedLabelText,
        visibleText,
        styleSelectorValue,
        promptStyles,
        selectedStyleDetails,
        styleDetailsText,
        styleTemplateRoot,
        styleTemplateInfo,
        optionValue,
        promptHash,
        readPromptTool,
        normalizePatchSeparator,
        applyPromptPatchText,
        normalizeDiffText,
        patchesFromSearchReplaceBlocks,
        patchesFromUnifiedDiff,
        patchesFromDiff,
        promptPatchResidue,
        patchPromptRoot,
        setNativeValueIfAvailable,
        compactPromptPatchResult,
        editPromptTool,
        askTeacherTool,
        executeAssistantTool,
        truncateAssistantText
    });
})();
