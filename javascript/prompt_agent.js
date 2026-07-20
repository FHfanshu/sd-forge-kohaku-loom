(function () {
    const promptAgent = window.__SD_FORGE_NEO_PROMPT_AGENT__ || {};
    window.__SD_FORGE_NEO_PROMPT_AGENT__ = promptAgent;

    function promptAgentApp() {
        const app = typeof gradioApp === "function" ? gradioApp() : null;
        return app || document;
    }

    function promptAgentMainApp() {
        const app = promptAgentApp();
        if (!app || typeof app.querySelector !== "function") return null;
        const hasMainTabs = !!app.querySelector("#tabs");
        const hasPromptBox = !!(app.querySelector("#txt2img_prompt") || app.querySelector("#img2img_prompt"));
        return hasMainTabs && hasPromptBox ? app : null;
    }

    function currentForgePreset() {
        const preset = promptAgentApp().querySelector("#forge_ui_preset");
        if (!preset) return "";

        const checked = preset.querySelector("input:checked");
        if (checked) return checked.value;

        const input = preset.querySelector("input");
        if (input) return input.value;

        const select = preset.querySelector("select");
        return select ? select.value : "";
    }

    function currentCheckpoint() {
        const root = promptAgentApp().querySelector("#setting_sd_model_checkpoint");
        if (!root) return "";
        const checked = root.querySelector("input:checked");
        if (checked) return String(checked.value || "");
        const input = root.querySelector("input");
        if (input) return String(input.value || "");
        const select = root.querySelector("select");
        return select ? String(select.value || "") : "";
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

    function switchMainTab(kind) {
        if (kind === "txt2img" && typeof switch_to_txt2img === "function") {
            switch_to_txt2img();
            return;
        }
        if (kind === "img2img" && typeof switch_to_img2img === "function") {
            switch_to_img2img();
            return;
        }
        const tabs = promptAgentApp().querySelector("#tabs");
        const buttons = tabs ? tabs.querySelectorAll("button") : [];
        const index = kind === "txt2img" ? 0 : 1;
        if (buttons[index]) buttons[index].click();
    }

    const assistantState = {
        promptReads: {},
        promptStyles: null,
        loadedPromptSkills: {},
        generationReads: {}
    };
    function activePromptTarget() {
        const app = promptAgentApp();
        const tabs = app.querySelector("#tabs");
        const selected = tabs ? Array.from(tabs.querySelectorAll("button")).find(function (button) {
            return button.getAttribute("aria-selected") === "true" || button.classList.contains("selected");
        }) : null;
        if (selected) {
            const identity = [
                selected.id,
                selected.getAttribute("aria-controls"),
                selected.getAttribute("data-tab-id"),
                selected.getAttribute("data-testid"),
                selected.getAttribute("href")
            ].filter(Boolean).join(" ").toLowerCase();
            if (identity.includes("img2img")) return "img2img";
            if (identity.includes("txt2img")) return "txt2img";
        }
        function visible(root) {
            if (!root || root.hidden || root.getAttribute("aria-hidden") === "true") return false;
            const style = typeof getComputedStyle === "function" ? getComputedStyle(root) : null;
            if (style && (style.display === "none" || style.visibility === "hidden")) return false;
            return typeof root.getClientRects !== "function" || root.getClientRects().length > 0;
        }
        const txtRoot = app.querySelector("#txt2img, #txt2img_interface, #txt2img_prompt");
        const imgRoot = app.querySelector("#img2img, #img2img_interface, #img2img_prompt");
        const txtVisible = visible(txtRoot);
        const imgVisible = visible(imgRoot);
        if (imgVisible && !txtVisible) return "img2img";
        return "txt2img";
    }

    function promptFieldRootForTarget(target, field) {
        const resolved = target === "active" || !target ? activePromptTarget() : target;
        const normalizedField = field === "negative" ? "negative" : "positive";
        const suffix = normalizedField === "negative" ? "_neg_prompt" : "_prompt";
        return {
            target: resolved,
            field: normalizedField,
            root: promptAgentApp().querySelector(`#${resolved}${suffix}`)
        };
    }

    function promptRootForTarget(target) {
        return promptFieldRootForTarget(target, "positive");
    }

    function normalizedLabelText(value) {
        return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    }

    function visibleText(node) {
        return String(node && node.textContent ? node.textContent : "").replace(/\s+/g, " ").trim();
    }

    function truncateAssistantText(value, limit) {
        const text = String(value || "");
        const max = Math.max(1, Number(limit) || 500);
        return text.length > max ? `${text.slice(0, max - 1)}…` : text;
    }

    function styleSelectorValue(target) {
        const app = promptAgentApp();
        const resolved = target === "img2img" ? "img2img" : "txt2img";
        const root = app.querySelector(`#${resolved}_styles`);
        if (!root) return "";

        const input = root.querySelector("label > div input, input[autocomplete='off'], input[role='combobox'], input:not([type]), textarea");
        const inputValue = input && String(input.value || "").trim();
        if (inputValue) return inputValue;

        const ignored = new Set(["styles", "style", "风格", "风格模板", "风格模版", ""]);
        const candidates = [];
        root.querySelectorAll("[data-testid='selected-option'], [data-testid='token'], .token, .selected, button, span").forEach(function (node) {
            const value = visibleText(node).replace(/^✓\s*|\s*✓$/g, "").trim();
            const text = normalizedLabelText(value);
            if (!ignored.has(text)) candidates.push(value);
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
        const endpoints = ["/prompt-agent/api/prompt-styles", "/sdapi/v1/prompt-styles"];
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
        const app = promptAgentApp();
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
                if (control && !control.closest("#prompt-agent-panel")) return node;
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
        const settings = promptAgentApp().querySelector("#settings_json textarea, #settings_json input");
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

    function promptContextSnapshot(target, styleSelector) {
        const positiveItem = promptFieldRootForTarget(target || "active", "positive");
        const negativeItem = promptFieldRootForTarget(positiveItem.target, "negative");
        const positive = textboxValue(positiveItem.root);
        const negative = textboxValue(negativeItem.root);
        const styles = styleSelector === undefined ? styleSelectorValue(positiveItem.target) : String(styleSelector || "");
        const forgePreset = currentForgePreset();
        const checkpoint = currentCheckpoint();
        const contextHash = promptHash(JSON.stringify({ positive, negative, styles, forgePreset, checkpoint }));
        return {
            target: positiveItem.target,
            positive: positive,
            negative: negative,
            positive_hash: promptHash(positive),
            negative_hash: promptHash(negative),
            context_hash: contextHash,
            style_selector: styles,
            forge_preset: forgePreset,
            checkpoint: checkpoint
        };
    }

    async function readPromptTool(target) {
        const item = promptRootForTarget(target || "active");
        const template = await styleTemplateInfo(item.target);
        const context = promptContextSnapshot(item.target, template.style_selector);
        assistantState.promptReads[item.target] = {
            hash: context.positive_hash,
            prompt: context.positive,
            positive: context.positive,
            negative: context.negative,
            positive_hash: context.positive_hash,
            negative_hash: context.negative_hash,
            context_hash: context.context_hash,
            style_selector: context.style_selector,
            at: Date.now()
        };
        return {
            ok: true,
            target: item.target,
            prompt: context.positive,
            prompt_hash: context.positive_hash,
            positive_prompt: context.positive,
            negative_prompt: context.negative,
            positive_prompt_hash: context.positive_hash,
            negative_prompt_hash: context.negative_hash,
            context_hash: context.context_hash,
            forge_preset: context.forge_preset,
            checkpoint: context.checkpoint,
            loaded_prompt_skills: Object.keys(assistantState.loadedPromptSkills || {}),
            style_template_found: template.found,
            style_template: template.template,
            style_selector: template.style_selector,
            selected_styles: template.selected_styles,
            forge_positive_template: template.forge_positive_template
        };
    }

    async function readStyleTemplateTool(target) {
        const item = promptRootForTarget(target || "active");
        const template = await styleTemplateInfo(item.target);
        return {
            ok: true,
            target: item.target,
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

    function escapeRegExp(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function flexiblePromptTextRange(text, find) {
        const normalized = String(find || "").trim();
        if (normalized.length < 20) return null;
        const parts = normalized.split(/\s+/).filter(Boolean).map(escapeRegExp);
        if (!parts.length) return null;
        const pattern = new RegExp(parts.join("\\s+"), "g");
        const matches = Array.from(String(text || "").matchAll(pattern));
        if (matches.length !== 1) return null;
        return { start: matches[0].index, end: matches[0].index + matches[0][0].length };
    }

    function applyPromptPatchText(text, patch) {
        const operation = String(patch.operation || patch.op || "replace").trim();
        const find = String(patch.find ?? patch.old ?? "");
        const replacement = String(patch.replace ?? patch.replacement ?? patch.text ?? "");
        const separator = normalizePatchSeparator(patch.separator ?? "");
        const count = Number.isFinite(Number(patch.count)) ? Math.max(0, Math.floor(Number(patch.count))) : 1;

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
            if (count > 10000) return { ok: false, error: "replace_n count exceeds 10000", text: text };
            let changed = 0;
            let cursor = 0;
            const parts = [];
            while (changed < count) {
                const index = text.indexOf(find, cursor);
                if (index < 0) break;
                parts.push(text.slice(cursor, index), replacement);
                cursor = index + find.length;
                changed += 1;
            }
            parts.push(text.slice(cursor));
            return { ok: true, text: parts.join(""), changed: changed };
        }
        if (operation === "replace") {
            if (!find) return { ok: false, error: "replace requires find text", text: text };
            if (patch.allow_multiple) return { ok: false, error: "replace always changes one match; use replace_all or replace_n for multiple matches", text: text };
            const first = text.indexOf(find);
            if (first < 0) {
                const flexible = flexiblePromptTextRange(text, find);
                if (flexible) return { ok: true, text: text.slice(0, flexible.start) + replacement + text.slice(flexible.end), changed: 1 };
                return { ok: false, error: "find text not found", text: text };
            }
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
        const loosePattern = /(?:^|\n)SEARCH\s*\n([\s\S]*?)\nREPLACE\s*\n([\s\S]*)$/;
        const loose = patches.length ? null : diff.match(loosePattern);
        if (loose) patches.push({ operation: "replace", find: loose[1], replace: loose[2] });
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

    function positivePromptNoPhrases(text) {
        const matches = [];
        const pattern = /\bno\s+[a-z0-9][\w-]*(?:\s+[a-z0-9][\w-]*){0,4}/gi;
        let match;
        while ((match = pattern.exec(String(text || ""))) !== null) matches.push(match[0]);
        return matches;
    }

    function patchPromptRoot(root, patches, baseHash, forbidNoPhrases) {
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
        const noPhrases = forbidNoPhrases ? positivePromptNoPhrases(next) : [];
        if (noPhrases.length) {
            return {
                ok: false,
                error: 'refusing to write positive prompt: do not use "no ..." phrases. Describe desired visible content positively, or put exclusions in the negative prompt.',
                no_phrases: noPhrases,
                prompt: current,
                attempted_prompt_preview: truncateAssistantText(next, 500)
            };
        }
        setNativeValueIfAvailable(target, next);
        return { ok: true, results: results, prompt: next, prompt_hash: promptHash(next) };
    }

    function setNativeValueIfAvailable(target, value) {
        const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : target instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
        if (descriptor && descriptor.set) descriptor.set.call(target, value);
        else target.value = value;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    }

    function forgeStateRoots() {
        return ["#txt2img", "#img2img", "#setting_sd_model_checkpoint", "#forge_ui_preset"];
    }

    function captureForgeUiState() {
        const app = promptAgentApp();
        const controls = [];
        forgeStateRoots().forEach(function (selector) {
            const root = app.querySelector(selector);
            if (!root) return;
            root.querySelectorAll("textarea, input, select").forEach(function (control, index) {
                if (control.type === "file" || control.closest("#prompt-agent-panel")) return;
                controls.push({
                    root: selector,
                    index: index,
                    tag: control.tagName,
                    type: control.type || "",
                    value: control.value,
                    checked: ["checkbox", "radio"].includes(control.type) ? control.checked : undefined
                });
            });
        });
        return { active_target: activePromptTarget(), controls: controls };
    }

    function restoreForgeUiState(snapshot) {
        if (!snapshot || !Array.isArray(snapshot.controls)) return false;
        const app = promptAgentApp();
        snapshot.controls.forEach(function (saved) {
            const root = app.querySelector(saved.root);
            const control = root?.querySelectorAll("textarea, input, select")[saved.index];
            if (!control || control.tagName !== saved.tag || (control.type || "") !== saved.type) return;
            if (["checkbox", "radio"].includes(saved.type)) {
                if (control.checked === saved.checked) return;
                control.checked = Boolean(saved.checked);
                control.dispatchEvent(new Event("input", { bubbles: true }));
                control.dispatchEvent(new Event("change", { bubbles: true }));
                return;
            }
            if (control.value !== saved.value) setNativeValueIfAvailable(control, saved.value);
        });
        assistantState.promptReads = {};
        switchMainTab(snapshot.active_target || "txt2img");
        return true;
    }

    const GENERATION_CONTROL_SELECTORS = {
        steps: function (target) { return [`#${target}_steps`]; },
        sampler_name: function (target) { return [`#${target}_sampling`, `#${target}_sampler_name`]; },
        scheduler: function (target) { return [`#${target}_scheduler`]; },
        cfg_scale: function (target) { return [`#${target}_cfg_scale`]; },
        seed: function (target) { return [`#${target}_seed`]; },
        width: function (target) { return [`#${target}_width`]; },
        height: function (target) { return [`#${target}_height`]; },
        denoising_strength: function (target) { return [`#${target}_denoising_strength`]; },
        batch_count: function (target) { return [`#${target}_batch_count`]; },
        batch_size: function (target) { return [`#${target}_batch_size`]; },
        enable_hr: function (target) { return [`#${target}_enable_hr`]; },
        hr_scale: function (target) { return [`#${target}_hr_scale`]; },
        hr_upscaler: function (target) { return [`#${target}_hr_upscaler`]; }
    };

    const GENERATION_KEYS = Object.freeze(Object.keys(GENERATION_CONTROL_SELECTORS));

    function generationControl(target, key) {
        const selectors = GENERATION_CONTROL_SELECTORS[key] ? GENERATION_CONTROL_SELECTORS[key](target) : [];
        for (const selector of selectors) {
            const root = promptAgentApp().querySelector(selector);
            if (!root) continue;
            if (root.matches && root.matches("input, select, textarea")) return root;
            const control = root.querySelector("input, select, textarea");
            if (control) return control;
        }
        return null;
    }

    function generationControlValue(control) {
        if (!control) return undefined;
        if (control.type === "checkbox" || control.type === "radio") return Boolean(control.checked);
        const raw = String(control.value ?? "");
        if (control.type === "number" || control.type === "range") {
            const number = Number(raw);
            return Number.isFinite(number) ? number : raw;
        }
        return raw;
    }

    function generationContextHash(target, parameters) {
        return promptHash(JSON.stringify({ target: target, parameters: parameters }));
    }

    function generationSnapshot(target) {
        const resolved = target === "active" || !target ? activePromptTarget() : target;
        const parameters = {};
        GENERATION_KEYS.forEach(function (key) {
            const value = generationControlValue(generationControl(resolved, key));
            if (value !== undefined) parameters[key] = value;
        });
        return {
            target: resolved,
            parameters: parameters,
            context_hash: generationContextHash(resolved, parameters)
        };
    }

    function readGenerationParametersTool(target) {
        const snapshot = generationSnapshot(target || "active");
        assistantState.generationReads[snapshot.target] = Object.assign({}, snapshot, { at: Date.now() });
        return Object.assign({ ok: true }, snapshot);
    }

    function writeGenerationControl(control, value) {
        if (!control) return false;
        if (control.type === "checkbox" || control.type === "radio") {
            const checked = Boolean(value);
            if (control.checked === checked) return true;
            control.checked = checked;
            control.dispatchEvent(new Event("input", { bubbles: true }));
            control.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
        }
        return setNativeValueIfAvailable(control, String(value));
    }

    function applyGenerationParametersTool(args) {
        const target = args.target || "active";
        const current = generationSnapshot(target);
        const expected = String(args.context_hash || "").trim();
        const remembered = assistantState.generationReads[current.target];
        if (!expected) return { ok: false, target: current.target, error: "context_hash from read_generation_parameters is required" };
        if (!remembered || remembered.context_hash !== expected) {
            return { ok: false, target: current.target, error: "context_hash does not match the latest read_generation_parameters result; read again" };
        }
        if (current.context_hash !== expected) {
            return { ok: false, target: current.target, error: "visible Forge generation controls changed after read; read again", actual_context_hash: current.context_hash };
        }
        const parameters = args.parameters && typeof args.parameters === "object" ? args.parameters : {};
        const changed = [];
        for (const key of Object.keys(parameters)) {
            if (!GENERATION_KEYS.includes(key)) return { ok: false, target: current.target, error: `generation parameter is not allowlisted: ${key}` };
            const control = generationControl(current.target, key);
            if (!control) return { ok: false, target: current.target, error: `Forge control is unavailable: ${key}` };
            if (!writeGenerationControl(control, parameters[key])) return { ok: false, target: current.target, error: `Forge control could not be changed: ${key}` };
            changed.push(key);
        }
        switchMainTab(current.target);
        const latest = readGenerationParametersTool(current.target);
        return Object.assign(latest, { changed: changed });
    }

    function sanitizeForgePublicResult(value) {
        if (Array.isArray(value)) return value.map(sanitizeForgePublicResult);
        if (!value || typeof value !== "object") return value;
        const result = {};
        Object.keys(value).forEach(function (key) {
            const normalized = key.toLowerCase().replace(/-/g, "_");
            if (["path", "filename", "file", "model_path", "mmproj_path", "llama_server_path", "endpoint", "api_key", "headers"].includes(normalized)) return;
            result[key] = sanitizeForgePublicResult(value[key]);
        });
        return result;
    }

    async function forgeApiTool(name, args, signal) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        let response;
        try {
            response = await fetch("/prompt-agent/api/forge-tools", {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tool: name, arguments: args || {} }),
                signal: signal
            });
        } catch (error) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            return { ok: false, error: { code: "forge_api_unavailable", message: error?.message || "Forge tool API is unavailable.", retryable: true } };
        }
        let payload;
        try { payload = await response.json(); } catch (_error) { payload = {}; }
        if (!response.ok) {
            const detail = payload.detail && typeof payload.detail === "object" ? payload.detail : payload.error;
            return { ok: false, error: detail?.error || detail || { code: "forge_api_error", message: `Forge tool API failed with HTTP ${response.status}.`, retryable: response.status >= 500 } };
        }
        return sanitizeForgePublicResult(payload);
    }

    async function validateForgeHostTool(name, args, signal) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        let response;
        try {
            response = await fetch("/prompt-agent/api/forge-tools/validate", {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tool: name, arguments: args || {} }),
                signal: signal
            });
        } catch (error) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            return { ok: false, error: { code: "forge_validation_unavailable", message: "Forge tool validation is unavailable.", retryable: true } };
        }
        let payload;
        try { payload = await response.json(); } catch (_error) { payload = {}; }
        if (!response.ok || payload?.ok !== true || !payload.arguments || typeof payload.arguments !== "object") {
            const detail = payload.detail && typeof payload.detail === "object" ? payload.detail : payload.error;
            return { ok: false, error: detail?.error || detail || { code: "validation_error", message: "Forge rejected the tool arguments.", retryable: false } };
        }
        return { ok: true, arguments: payload.arguments };
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
        const field = args.field === "negative" ? "negative" : "positive";
        const item = promptFieldRootForTarget(args.target || "active", field);
        const readState = assistantState.promptReads[item.target];
        const fieldHash = field === "negative" ? "negative_hash" : "positive_hash";
        const fieldText = field === "negative" ? "negative" : "positive";
        const baseHash = String(args.base_hash || args.prompt_hash || "").trim();
        const patchSource = args.patches !== undefined ? args.patches : args.operations !== undefined ? args.operations : args.patch !== undefined ? args.patch : patches;
        let patchList;
        if (args.diff && typeof args.diff === "object" && !Array.isArray(args.diff)) {
            patchList = args.diff.find !== undefined || args.diff.replace !== undefined || args.diff.text !== undefined ? [args.diff] : patchesFromDiff(args.diff.diff);
        } else {
            patchList = args.diff !== undefined ? patchesFromDiff(args.diff) : Array.isArray(patchSource) ? patchSource : patchSource && typeof patchSource === "object" ? [patchSource] : [];
        }
        if (!readState) {
            return { ok: false, target: item.target, error: "must call read_prompt for this target before edit_prompt" };
        }
        if (!baseHash) {
            return { ok: false, target: item.target, field: field, error: "edit_prompt requires base_hash from read_prompt", last_read_hash: readState[fieldHash] };
        }
        if (baseHash !== readState[fieldHash]) {
            return { ok: false, target: item.target, field: field, error: "base_hash does not match the latest read_prompt result; read again", last_read_hash: readState[fieldHash] };
        }
        if ((!Array.isArray(patchList) || !patchList.length) && args.prompt !== undefined) {
            const prompt = String(args.prompt || "");
            patchList = readState[fieldText] ? [{ operation: "replace", find: readState[fieldText], replace: prompt }] : [{ operation: "append", text: prompt }];
        }
        if (!Array.isArray(patchList) || !patchList.length) {
            return { ok: false, target: item.target, error: "edit_prompt requires diff or patches" };
        }
        const rawResult = patchPromptRoot(item.root, patchList, baseHash, field === "positive");
        const result = compactPromptPatchResult(rawResult, Boolean(args.return_prompt));
        if (result.ok) {
            switchMainTab(item.target);
            readState[fieldText] = rawResult.prompt || "";
            readState[fieldHash] = result.prompt_hash;
            readState.prompt = readState.positive;
            readState.hash = readState.positive_hash;
            const current = promptContextSnapshot(item.target);
            readState.context_hash = current.context_hash;
            readState.style_selector = current.style_selector;
            readState.at = Date.now();
        }
        return Object.assign({ target: item.target, field: field, context_hash: readState.context_hash }, result);
    }

    async function executeAssistantTool(tool, signal) {
        const name = tool.tool || tool.name;
        let args = tool.arguments || {};
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        if ([
            "read_prompt", "edit_prompt", "read_negative_prompt", "edit_negative_prompt",
            "read_generation_parameters", "apply_generation_parameters"
        ].includes(name)) {
            const validation = await validateForgeHostTool(name, args, signal);
            if (!validation.ok) return validation;
            args = validation.arguments;
        }
        if (name === "read_prompt" || name === "get_current_prompt") {
            return await readPromptTool(args.target || "active");
        }
        if (name === "read_style_template") {
            return await readStyleTemplateTool(args.target || "active");
        }
        if (name === "edit_prompt") {
            return editPromptTool(args, args.patches || args.patch || []);
        }
        if (name === "read_negative_prompt") {
            const result = await readPromptTool(args.target || "active");
            return Object.assign({}, result, { prompt: result.negative_prompt, prompt_hash: result.negative_prompt_hash });
        }
        if (name === "edit_negative_prompt") {
            return editPromptTool(Object.assign({}, args, { field: "negative" }), args.patches || args.patch || []);
        }
        if (name === "read_generation_parameters") return readGenerationParametersTool(args.target || "active");
        if (name === "apply_generation_parameters") return applyGenerationParametersTool(args);
        if (name === "list_resources") {
            const result = await resourceGet("/prompt-agent/api/resources/search", {
                kind: args.kind,
                query: args.query || "",
                limit: args.limit || 20,
                cursor: args.cursor || ""
            }, signal);
            return sanitizeForgePublicResult(result);
        }
        if (name === "read_resource_metadata") {
            const result = await resourceGet("/prompt-agent/api/resources/inspect", {
                kind: args.kind,
                id: args.id,
                query: args.query || "",
                limit: args.limit || 20,
                cursor: args.cursor || ""
            }, signal);
            return sanitizeForgePublicResult(result);
        }
        if (name === "ask_teacher" || name === "list_models" || name === "list_loras" || name === "list_embeddings") {
            return await forgeApiTool(name, args, signal);
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
        const resourceExecutor = promptAgent.executeResourceTool;
        if (typeof resourceExecutor === "function") {
            const resourceResult = await resourceExecutor(tool, signal);
            if (resourceResult !== undefined) return resourceResult;
        }
        return { ok: false, error: `unknown tool: ${name}` };
    }

    Object.assign(promptAgent, {
        promptAgentApp,
        promptAgentMainApp,
        currentForgePreset,
        currentCheckpoint,
        textboxValue,
        setTextboxValue,
        switchMainTab,
        assistantState,
        activePromptTarget,
        promptFieldRootForTarget,
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
        promptContextSnapshot,
        readPromptTool,
        readStyleTemplateTool,
        normalizePatchSeparator,
        applyPromptPatchText,
        normalizeDiffText,
        patchesFromSearchReplaceBlocks,
        patchesFromUnifiedDiff,
        patchesFromDiff,
        promptPatchResidue,
        positivePromptNoPhrases,
        patchPromptRoot,
        setNativeValueIfAvailable,
        captureForgeUiState,
        restoreForgeUiState,
        compactPromptPatchResult,
        editPromptTool,
        generationSnapshot,
        readGenerationParametersTool,
        applyGenerationParametersTool,
        forgeApiTool,
        executeAssistantTool
    });
})();
