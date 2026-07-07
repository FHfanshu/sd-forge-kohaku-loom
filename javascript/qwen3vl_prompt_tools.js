(function () {
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
        promptStyles: null
    };

    function assistantConfig() {
        const panel = assistantPanel();
        const get = function (name, fallback) {
            const value = panel ? panel.querySelector(`[data-q3vl-setting="${name}"]`)?.value : localStorage.getItem(`q3vl_assistant_${name}`);
            return value || fallback;
        };
        const endpoint = get("endpoint", "https://api.deepseek.com");
        return {
            backend: get("backend", "deepseek"),
            endpoint: endpoint,
            model: normalizeAssistantModel(endpoint, get("model", "deepseek-v4-pro")),
            api_key: get("api_key", ""),
            local_endpoint: get("local_endpoint", "http://127.0.0.1:8080/v1"),
            local_model: get("local_model", "hauhau-qwen3.5-9b-uncensored"),
            temperature: 0.35,
            top_p: 0.9,
            max_tokens: normalizeAssistantMaxTokens(get("max_tokens", "8192")),
            reasoning_effort: get("reasoning_effort", "high"),
            timeout: 120
        };
    }

    function normalizeAssistantModel(endpoint, model) {
        const cleaned = String(model || "").trim() || "deepseek-v4-pro";
        try {
            const url = new URL(String(endpoint || ""));
            if (url.hostname === "api.deepseek.com" && cleaned === "deepseekv4-pro") return "deepseek-v4-pro";
            if (url.hostname === "api.deepseek.com" && cleaned === "deepseek-chat") return "deepseek-v4-pro";
            if (url.hostname === "api.deepseek.com" && cleaned === "deepseek-reasoner") return "deepseek-v4-pro";
        } catch (_error) { }
        return cleaned;
    }

    function normalizeAssistantMaxTokens(value) {
        const parsed = Number.parseInt(String(value || ""), 10);
        if (!Number.isFinite(parsed) || parsed < 512) return 8192;
        return Math.min(parsed, 65536);
    }

    function saveAssistantConfig() {
        const panel = assistantPanel();
        if (!panel) return;
        panel.querySelectorAll("[data-q3vl-setting]").forEach(function (input) {
            localStorage.setItem(`q3vl_assistant_${input.dataset.q3vlSetting}`, input.value || "");
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

    async function executeAssistantTool(tool) {
        const name = tool.tool || tool.name;
        const args = tool.arguments || {};
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

    function parseAssistantTool(text) {
        let raw = String(text || "").trim();
        raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        try {
            const parsed = JSON.parse(raw);
            if (parsed && (parsed.tool || parsed.name)) return parsed;
        } catch (_error) {
            const match = raw.match(/\{[\s\S]*\}/);
            if (match) {
                try {
                    const parsed = JSON.parse(match[0]);
                    if (parsed && (parsed.tool || parsed.name)) return parsed;
                } catch (_ignored) { }
            }
        }
        return null;
    }

    function safeMarkdownHref(href) {
        const raw = String(href || "").trim();
        if (!raw) return "";
        if (raw.startsWith("#")) return raw;
        try {
            const url = new URL(raw, window.location.href);
            if (["http:", "https:", "mailto:"].includes(url.protocol)) return url.href;
        } catch (_error) { }
        return "";
    }

    function appendInlineMarkdown(parent, text) {
        const value = String(text || "");
        let index = 0;

        function appendText(until) {
            if (until > index) parent.appendChild(document.createTextNode(value.slice(index, until)));
            index = until;
        }

        while (index < value.length) {
            if (value.startsWith("`", index)) {
                const end = value.indexOf("`", index + 1);
                if (end > index + 1) {
                    const code = document.createElement("code");
                    code.textContent = value.slice(index + 1, end);
                    parent.appendChild(code);
                    index = end + 1;
                    continue;
                }
            }

            const strongMarker = value.startsWith("**", index) ? "**" : value.startsWith("__", index) ? "__" : "";
            if (strongMarker) {
                const end = value.indexOf(strongMarker, index + 2);
                if (end > index + 2) {
                    const strong = document.createElement("strong");
                    appendInlineMarkdown(strong, value.slice(index + 2, end));
                    parent.appendChild(strong);
                    index = end + 2;
                    continue;
                }
            }

            const emMarker = value[index] === "*" || value[index] === "_" ? value[index] : "";
            if (emMarker && value[index + 1] !== emMarker) {
                const end = value.indexOf(emMarker, index + 1);
                if (end > index + 1) {
                    const em = document.createElement("em");
                    appendInlineMarkdown(em, value.slice(index + 1, end));
                    parent.appendChild(em);
                    index = end + 1;
                    continue;
                }
            }

            if (value[index] === "[") {
                const labelEnd = value.indexOf("]", index + 1);
                const hrefStart = labelEnd >= 0 && value[labelEnd + 1] === "(" ? labelEnd + 2 : -1;
                const hrefEnd = hrefStart >= 0 ? value.indexOf(")", hrefStart) : -1;
                if (labelEnd > index + 1 && hrefEnd > hrefStart) {
                    const href = safeMarkdownHref(value.slice(hrefStart, hrefEnd));
                    if (href) {
                        const link = document.createElement("a");
                        link.href = href;
                        link.target = "_blank";
                        link.rel = "noopener noreferrer";
                        appendInlineMarkdown(link, value.slice(index + 1, labelEnd));
                        parent.appendChild(link);
                        index = hrefEnd + 1;
                        continue;
                    }
                }
            }

            const nextSpecials = ["`", "*", "_", "["].map(function (char) {
                const found = value.indexOf(char, index + 1);
                return found < 0 ? value.length : found;
            });
            appendText(Math.min.apply(Math, nextSpecials));
        }
    }

    function appendInlineMarkdownWithBreaks(parent, text) {
        String(text || "").split("\n").forEach(function (line, index) {
            if (index > 0) parent.appendChild(document.createElement("br"));
            appendInlineMarkdown(parent, line);
        });
    }

    function renderAssistantMarkdown(root, text) {
        root.textContent = "";
        root.classList.add("q3vl-markdown");
        const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
        let paragraph = [];
        let list = null;
        let listType = "";
        let fence = null;

        function closeList() {
            list = null;
            listType = "";
        }

        function flushParagraph() {
            if (!paragraph.length) return;
            const p = document.createElement("p");
            appendInlineMarkdownWithBreaks(p, paragraph.join("\n"));
            root.appendChild(p);
            paragraph = [];
        }

        function appendListItem(type, text) {
            flushParagraph();
            if (!list || listType !== type) {
                closeList();
                list = document.createElement(type);
                listType = type;
                root.appendChild(list);
            }
            const li = document.createElement("li");
            appendInlineMarkdown(li, text);
            list.appendChild(li);
        }

        for (const line of lines) {
            const fenceMatch = line.match(/^```\s*([\w-]+)?\s*$/);
            if (fence) {
                if (fenceMatch) {
                    const pre = document.createElement("pre");
                    const code = document.createElement("code");
                    if (fence.language) code.className = `language-${fence.language}`;
                    code.textContent = fence.lines.join("\n");
                    pre.appendChild(code);
                    root.appendChild(pre);
                    fence = null;
                } else {
                    fence.lines.push(line);
                }
                continue;
            }

            if (fenceMatch) {
                flushParagraph();
                closeList();
                fence = { language: fenceMatch[1] || "", lines: [] };
                continue;
            }

            if (!line.trim()) {
                flushParagraph();
                closeList();
                continue;
            }

            const heading = line.match(/^(#{1,4})\s+(.+)$/);
            if (heading) {
                flushParagraph();
                closeList();
                const h = document.createElement(`h${Math.min(6, heading[1].length + 3)}`);
                appendInlineMarkdown(h, heading[2]);
                root.appendChild(h);
                continue;
            }

            if (/^\s*[-*_]{3,}\s*$/.test(line)) {
                flushParagraph();
                closeList();
                root.appendChild(document.createElement("hr"));
                continue;
            }

            const quote = line.match(/^>\s?(.+)$/);
            if (quote) {
                flushParagraph();
                closeList();
                const blockquote = document.createElement("blockquote");
                appendInlineMarkdown(blockquote, quote[1]);
                root.appendChild(blockquote);
                continue;
            }

            const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
            if (unordered) {
                appendListItem("ul", unordered[1]);
                continue;
            }

            const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
            if (ordered) {
                appendListItem("ol", ordered[1]);
                continue;
            }

            closeList();
            paragraph.push(line);
        }

        if (fence) {
            const pre = document.createElement("pre");
            const code = document.createElement("code");
            code.textContent = fence.lines.join("\n");
            pre.appendChild(code);
            root.appendChild(pre);
        }
        flushParagraph();
    }

    function addAssistantMessage(role, text) {
        const log = assistantPanel()?.querySelector("#q3vl_assistant_messages");
        if (!log) return;
        const item = document.createElement("div");
        item.className = `q3vl-assistant-msg q3vl-assistant-${role}`;
        if (role === "assistant" || role === "tool") {
            renderAssistantMarkdown(item, text);
        } else {
            item.textContent = text;
        }
        log.appendChild(item);
        log.scrollTop = log.scrollHeight;
    }

    function addAssistantUserMessage(text, attachment) {
        const log = assistantPanel()?.querySelector("#q3vl_assistant_messages");
        if (!log) return;
        const item = document.createElement("div");
        item.className = "q3vl-assistant-msg q3vl-assistant-user";
        if (text) {
            const body = document.createElement("div");
            body.textContent = text;
            item.appendChild(body);
        }
        if (attachment) {
            const media = document.createElement("div");
            media.className = "q3vl-assistant-user-attachment";
            const image = document.createElement("img");
            image.src = attachment.dataUrl;
            image.alt = attachment.name || "reference image";
            const name = document.createElement("span");
            name.textContent = attachment.name || "reference image";
            media.appendChild(image);
            media.appendChild(name);
            item.appendChild(media);
        }
        log.appendChild(item);
        log.scrollTop = log.scrollHeight;
    }

    function truncateAssistantText(text, limit) {
        const value = String(text || "").trim();
        return value.length > limit ? `${value.slice(0, limit)}...` : value;
    }

    async function analyzeAssistantAttachment(attachment, userText) {
        const config = assistantConfig();
        const response = await fetch("/qwen3vl-prompt-tools/analyze-image", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                image: attachment.dataUrl,
                filename: attachment.name,
                local_endpoint: config.local_endpoint,
                local_model: config.local_model,
                timeout: 120
            })
        });
        if (!response.ok) {
            const detail = await response.text();
            if (response.status === 404) {
                throw new Error("本地视觉分析接口未注册。请重启 Forge/WebUI 后再试。原始错误: " + detail);
            }
            throw new Error(detail);
        }
        return await response.json();
    }

    function setAssistantAttachment(attachment) {
        assistantState.attachment = attachment;
        renderAssistantAttachment();
    }

    function renderAssistantAttachment() {
        const panel = assistantPanel();
        const holder = panel?.querySelector("#q3vl_assistant_attachment");
        if (!holder) return;
        holder.textContent = "";
        holder.classList.toggle("q3vl-assistant-attachment-empty", !assistantState.attachment);
        if (!assistantState.attachment) return;
        const image = document.createElement("img");
        image.src = assistantState.attachment.dataUrl;
        image.alt = assistantState.attachment.name || "reference image";
        const meta = document.createElement("div");
        meta.className = "q3vl-assistant-attachment-meta";
        const title = document.createElement("strong");
        title.textContent = assistantState.attachment.name || "reference image";
        const hint = document.createElement("span");
        hint.textContent = "发送时由本地 Qwen3.5 VLM 先分析";
        meta.appendChild(title);
        meta.appendChild(hint);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "q3vl-assistant-chip-button";
        remove.textContent = "移除";
        remove.addEventListener("click", function () { setAssistantAttachment(null); });
        holder.appendChild(image);
        holder.appendChild(meta);
        holder.appendChild(remove);
    }

    function readAssistantImageFile(file) {
        return new Promise(function (resolve, reject) {
            if (!file) {
                reject(new Error("no file selected"));
                return;
            }
            if (!String(file.type || "").startsWith("image/")) {
                reject(new Error("请选择图片文件。"));
                return;
            }
            if (file.size > 24 * 1024 * 1024) {
                reject(new Error("图片太大，请选择 24 MB 以下的文件。"));
                return;
            }
            const reader = new FileReader();
            reader.onload = function () {
                resolve({ name: file.name, dataUrl: String(reader.result || "") });
            };
            reader.onerror = function () { reject(new Error("读取图片失败。")); };
            reader.readAsDataURL(file);
        });
    }

    async function callPromptAssistant() {
        const payload = Object.assign(assistantConfig(), { messages: assistantState.messages });
        const response = await fetch("/qwen3vl-prompt-tools/assistant", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const detail = await response.text();
            if (response.status === 404) {
                throw new Error("助手后端接口未注册。请重启 Forge/WebUI 后再试；只刷新浏览器不会注册新的 /qwen3vl-prompt-tools/assistant route。原始错误: " + detail);
            }
            throw new Error(detail);
        }
        return await response.json();
    }

    function normalizeAssistantToolCalls(result, text) {
        const calls = Array.isArray(result.tool_calls) ? result.tool_calls : [];
        if (calls.length) {
            return calls.map(function (call) {
                return {
                    tool: call.tool || call.name,
                    arguments: call.arguments || {}
                };
            }).filter(function (call) { return call.tool; });
        }
        const parsed = parseAssistantTool(text);
        return parsed ? [parsed] : [];
    }

    function assistantUserRequestedPromptEdit(text) {
        const value = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (!value) return false;
        const editVerb = /(改成|修改|改写|重写|优化|精炼|扩写|替换|追加|加上|加入|删除|移除|写入|更新|套用|应用|编辑|修一下|insert|append|replace|rewrite|edit|update|apply|change|remove|delete|optimi[sz]e|refine|expand)/i;
        const currentPromptRef = /(当前|现在|现有|原来|原有|这个|这段|它|其|提示词|prompt|txt2img|img2img|webui|ui|输入框|文本框)/i;
        const directEdit = /(帮我|请|直接|把|将|给我).{0,30}(改成|修改|改写|重写|优化|精炼|扩写|替换|追加|加上|加入|删除|移除|写入|更新|套用|应用|编辑|修一下)/i;
        const adviceOnly = /(怎么改|如何改|哪里.*改|修改建议|改进建议|优化建议|建议.*(修改|优化|改写|调整)|should.*(change|edit|rewrite)|how.*(change|edit|rewrite))/i;
        return editVerb.test(value) && !adviceOnly.test(value) && (currentPromptRef.test(value) || directEdit.test(value));
    }

    function assistantToolMutatesPrompt(name) {
        return ["edit_prompt", "patch_current_prompt", "multi_patch_current_prompt"].includes(String(name || ""));
    }

    async function runAssistantLoop(userText, attachment) {
        const effectiveText = userText || (attachment ? "请根据附件例图分析构图和风格，帮助我整理提示词。" : "");
        const mustEditPrompt = assistantUserRequestedPromptEdit(effectiveText);
        let promptEdited = false;
        let missingEditCorrectionSent = false;
        if (effectiveText || attachment) {
            addAssistantUserMessage(effectiveText, attachment);
        }
        const sendButton = assistantPanel()?.querySelector("#q3vl_assistant_send");
        if (sendButton) sendButton.disabled = true;
        try {
            if (attachment) {
                addAssistantMessage("status", "本地 Qwen3.5 正在分析附件...");
                const vision = await analyzeAssistantAttachment(attachment, effectiveText);
                const visionText = String(vision.text || "").trim();
                addAssistantMessage("tool", `视觉摘要 (${vision.model || "local Qwen3.5"}):\n${truncateAssistantText(visionText, 1200)}`);
                assistantState.messages.push({
                    role: "user",
                    content: `Reference image observation from local Qwen3.5 VLM (${attachment.name || "image"}):\n${visionText}`
                });
            }
            if (effectiveText) {
                assistantState.messages.push({ role: "user", content: effectiveText });
            }
            for (let i = 0; i < 6; i += 1) {
                addAssistantMessage("status", "思考中...");
                const result = await callPromptAssistant();
                const text = result.text || "";
                const toolCalls = normalizeAssistantToolCalls(result, text);
                if (!toolCalls.length) {
                    if (mustEditPrompt && !promptEdited) {
                        assistantState.messages.push({ role: "assistant", content: text || "No tool call returned." });
                        if (!missingEditCorrectionSent) {
                            missingEditCorrectionSent = true;
                            addAssistantMessage("tool", "未检测到 edit_prompt，继续要求助手实际修改当前提示词...");
                            assistantState.messages.push({
                                role: "user",
                                content: "The user asked to modify the current WebUI prompt. You must not claim it was changed unless edit_prompt succeeds. Call read_prompt if needed, then call edit_prompt with the latest base_hash. Do not give a final answer until edit_prompt returns ok:true."
                            });
                            continue;
                        }
                        addAssistantMessage("error", "助手没有调用 edit_prompt，当前提示词未被修改。请重试或明确要求“读取当前提示词并编辑”。");
                        return;
                    }
                    assistantState.messages.push({ role: "assistant", content: text });
                    addAssistantMessage("assistant", text);
                    return;
                }
                assistantState.messages.push({ role: "assistant", content: text || `Tool request: ${toolCalls.map(function (call) { return call.tool; }).join(", ")}` });
                for (const tool of toolCalls) {
                    const toolName = tool.tool || tool.name;
                    const toolResult = await executeAssistantTool(tool);
                    if (assistantToolMutatesPrompt(toolName) && toolResult.ok) promptEdited = true;
                    addAssistantMessage("tool", `工具 ${toolName}: ${toolResult.ok ? "完成" : "失败"}`);
                    assistantState.messages.push({ role: "user", content: `Tool result for ${toolName}: ${JSON.stringify(toolResult)}` });
                }
            }
            addAssistantMessage("assistant", "工具调用次数过多，已停止。请换一种更直接的指令。比如：读取当前提示词并改成三人自拍构图。 ");
        } catch (error) {
            addAssistantMessage("error", String(error.message || error));
        } finally {
            if (sendButton) sendButton.disabled = false;
        }
    }

    function setupAssistantWindow() {
        if (!q3vlMainApp()) {
            removeAssistantWindow();
            return;
        }
        const existingLaunchers = document.querySelectorAll("#q3vl_assistant_launcher");
        const existingPanels = document.querySelectorAll("#q3vl_assistant_panel");
        if (existingLaunchers.length === 1 && existingPanels.length === 1) return;
        if (existingLaunchers.length || existingPanels.length) removeAssistantWindow();
        const launcher = document.createElement("button");
        launcher.id = "q3vl_assistant_launcher";
        launcher.type = "button";
        launcher.textContent = "LLM 助手";
        document.body.appendChild(launcher);
        restoreAssistantLauncherPosition(launcher);

        const panel = document.createElement("div");
        panel.id = "q3vl_assistant_panel";
        panel.innerHTML = `
            <div class="q3vl-assistant-head"><div><strong>LLM 提示词助手</strong><span>文本改写 + 本地视觉</span></div><button type="button" id="q3vl_assistant_close" class="q3vl-assistant-close" title="关闭">×</button></div>
            <details class="q3vl-assistant-config">
                <summary><span>设置</span><span class="q3vl-assistant-config-hint">后端 / 模型 / API key</span></summary>
                <div class="q3vl-assistant-settings">
                    <select data-q3vl-setting="backend">
                        <option value="deepseek">DeepSeek / OpenAI-compatible</option>
                        <option value="local-lmcpp">本地 llama.cpp endpoint</option>
                    </select>
                    <input data-q3vl-setting="endpoint" placeholder="DeepSeek endpoint">
                    <input data-q3vl-setting="model" placeholder="DeepSeek model">
                    <input data-q3vl-setting="max_tokens" placeholder="Max tokens">
                    <select data-q3vl-setting="reasoning_effort">
                        <option value="high">Thinking high</option>
                        <option value="max">Thinking max</option>
                    </select>
                    <input data-q3vl-setting="api_key" placeholder="API key" type="password">
                    <input data-q3vl-setting="local_endpoint" placeholder="local lmcpp endpoint">
                    <input data-q3vl-setting="local_model" placeholder="local model">
                </div>
            </details>
            <div id="q3vl_assistant_messages"></div>
            <div id="q3vl_assistant_attachment" class="q3vl-assistant-attachment q3vl-assistant-attachment-empty"></div>
            <div class="q3vl-assistant-composer">
                <textarea id="q3vl_assistant_input" placeholder="例如：读取当前提示词，改成三名角色的自拍构图，明确左中右位置。Enter 换行，Ctrl+Enter 发送。"></textarea>
                <div class="q3vl-assistant-actions">
                    <div class="q3vl-assistant-action-group"><button type="button" id="q3vl_assistant_attach" class="q3vl-assistant-secondary">附图</button><button type="button" id="q3vl_assistant_read" class="q3vl-assistant-secondary">读取</button></div>
                    <div class="q3vl-assistant-action-group"><button type="button" id="q3vl_assistant_clear" class="q3vl-assistant-ghost">清空</button><button type="button" id="q3vl_assistant_send" class="q3vl-assistant-primary">发送</button></div>
                </div>
                <input id="q3vl_assistant_file" type="file" accept="image/*" hidden>
            </div>
        `;
        document.body.appendChild(panel);
        restoreAssistantPosition(panel);
        const config = panel.querySelector(".q3vl-assistant-config");
        config.open = localStorage.getItem("q3vl_assistant_config_open") === "1";
        config.addEventListener("toggle", function () {
            localStorage.setItem("q3vl_assistant_config_open", config.open ? "1" : "0");
        });
        const backend = panel.querySelector('[data-q3vl-setting="backend"]');
        backend.value = localStorage.getItem("q3vl_assistant_backend") || "deepseek";
        const endpointInput = panel.querySelector('[data-q3vl-setting="endpoint"]');
        const modelInput = panel.querySelector('[data-q3vl-setting="model"]');
        endpointInput.value = localStorage.getItem("q3vl_assistant_endpoint") || "https://api.deepseek.com";
        modelInput.value = normalizeAssistantModel(endpointInput.value, localStorage.getItem("q3vl_assistant_model") || "deepseek-v4-pro");
        if (modelInput.value !== localStorage.getItem("q3vl_assistant_model")) {
            localStorage.setItem("q3vl_assistant_model", modelInput.value);
        }
        panel.querySelector('[data-q3vl-setting="api_key"]').value = localStorage.getItem("q3vl_assistant_api_key") || "";
        panel.querySelector('[data-q3vl-setting="max_tokens"]').value = String(normalizeAssistantMaxTokens(localStorage.getItem("q3vl_assistant_max_tokens") || "8192"));
        panel.querySelector('[data-q3vl-setting="reasoning_effort"]').value = localStorage.getItem("q3vl_assistant_reasoning_effort") || "high";
        panel.querySelector('[data-q3vl-setting="local_endpoint"]').value = localStorage.getItem("q3vl_assistant_local_endpoint") || "http://127.0.0.1:8080/v1";
        panel.querySelector('[data-q3vl-setting="local_model"]').value = localStorage.getItem("q3vl_assistant_local_model") || "hauhau-qwen3.5-9b-uncensored";
        panel.querySelectorAll("[data-q3vl-setting]").forEach(function (input) {
            input.addEventListener("change", saveAssistantConfig);
            input.addEventListener("input", saveAssistantConfig);
        });
        launcher.addEventListener("click", function () {
            if (launcher.dataset.q3vlSuppressClick === "1") return;
            panel.classList.toggle("q3vl-assistant-open");
            if (panel.classList.contains("q3vl-assistant-open") && !localStorage.getItem("q3vl_assistant_position")) {
                requestAnimationFrame(function () { positionAssistantPanelNearLauncher(panel, launcher); });
            }
        });
        panel.querySelector("#q3vl_assistant_close").addEventListener("click", function () { panel.classList.remove("q3vl-assistant-open"); });
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
            runAssistantLoop("Read the current prompt and WebUI style template. Briefly summarize the composition, trigger words, and spatial relationships they describe. If both are empty, say they are empty.");
        });
        panel.querySelector("#q3vl_assistant_clear").addEventListener("click", function () {
            assistantState.messages = [];
            setAssistantAttachment(null);
            panel.querySelector("#q3vl_assistant_messages").textContent = "";
        });
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

    function positionAssistantPanelNearLauncher(panel, launcher) {
        if (!panel || !launcher || window.matchMedia("(max-width: 720px)").matches) return;
        const launcherRect = launcher.getBoundingClientRect();
        const panelWidth = panel.offsetWidth || 460;
        const panelHeight = panel.offsetHeight || 560;
        const left = Math.max(8, Math.min(launcherRect.left, window.innerWidth - panelWidth - 8));
        const preferredTop = launcherRect.top - panelHeight - 12;
        const fallbackTop = launcherRect.bottom + 12;
        const top = preferredTop >= 8
            ? preferredTop
            : Math.max(8, Math.min(fallbackTop, window.innerHeight - panelHeight - 8));
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
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
            localStorage.removeItem("q3vl_assistant_position");
            if (panel && panel.classList.contains("q3vl-assistant-open")) {
                positionAssistantPanelNearLauncher(panel, launcher);
            }
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

    function restoreAssistantPosition(panel) {
        const raw = localStorage.getItem("q3vl_assistant_position");
        if (!raw || window.matchMedia("(max-width: 720px)").matches) return;
        try {
            const pos = JSON.parse(raw);
            if (Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
                panel.style.left = `${Math.max(8, Math.min(pos.left, window.innerWidth - 120))}px`;
                panel.style.top = `${Math.max(8, Math.min(pos.top, window.innerHeight - 80))}px`;
                panel.style.right = "auto";
                panel.style.bottom = "auto";
            }
        } catch (_error) { }
    }

    function makeAssistantDraggable(panel, handle) {
        if (!panel || !handle || handle.dataset.q3vlDragBound) return;
        handle.dataset.q3vlDragBound = "1";
        let dragging = false;
        let startX = 0;
        let startY = 0;
        let startLeft = 0;
        let startTop = 0;

        function pointerDown(event) {
            if (event.target && event.target.closest("button")) return;
            if (window.matchMedia("(max-width: 720px)").matches) return;
            const rect = panel.getBoundingClientRect();
            dragging = true;
            startX = event.clientX;
            startY = event.clientY;
            startLeft = rect.left;
            startTop = rect.top;
            panel.style.left = `${rect.left}px`;
            panel.style.top = `${rect.top}px`;
            panel.style.right = "auto";
            panel.style.bottom = "auto";
            handle.setPointerCapture?.(event.pointerId);
            event.preventDefault();
        }

        function pointerMove(event) {
            if (!dragging) return;
            const left = Math.max(8, Math.min(startLeft + event.clientX - startX, window.innerWidth - panel.offsetWidth - 8));
            const top = Math.max(8, Math.min(startTop + event.clientY - startY, window.innerHeight - panel.offsetHeight - 8));
            panel.style.left = `${left}px`;
            panel.style.top = `${top}px`;
        }

        function pointerUp() {
            if (!dragging) return;
            dragging = false;
            const rect = panel.getBoundingClientRect();
            localStorage.setItem("q3vl_assistant_position", JSON.stringify({ left: rect.left, top: rect.top }));
        }

        handle.addEventListener("pointerdown", pointerDown);
        window.addEventListener("pointermove", pointerMove);
        window.addEventListener("pointerup", pointerUp);
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
