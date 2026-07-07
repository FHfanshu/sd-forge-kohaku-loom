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
        attachment: null
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
            max_tokens: 768,
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
                const control = node.querySelector("textarea, input");
                if (control && !control.closest("#q3vl_assistant_panel")) return node;
                node = node.parentElement;
            }
        }
        return null;
    }

    function styleTemplateInfo() {
        const root = styleTemplateRoot();
        return {
            found: !!root,
            template: textboxValue(root)
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

    function patchPromptRoot(root, patches) {
        if (!root) return { ok: false, error: "prompt field not found", prompt: "" };
        const target = root.querySelector("textarea") || root.querySelector("input");
        if (!target) return { ok: false, error: "prompt input not found", prompt: "" };
        const list = Array.isArray(patches) ? patches : [patches];
        if (!list.length) return { ok: false, error: "no patches provided", prompt: target.value || "" };
        let next = target.value || "";
        const results = [];
        for (let i = 0; i < list.length; i += 1) {
            const result = applyPromptPatchText(next, list[i] || {});
            results.push({ index: i, ok: result.ok, error: result.error || "", changed: result.changed || 0 });
            if (!result.ok) {
                return { ok: false, error: result.error, failed_index: i, results: results, prompt: next };
            }
            next = result.text;
        }
        setNativeValueIfAvailable(target, next);
        return { ok: true, results: results, prompt: next };
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

    function executeAssistantTool(tool) {
        const name = tool.tool || tool.name;
        const args = tool.arguments || {};
        if (name === "get_current_prompt") {
            const item = promptRootForTarget(args.target || "active");
            const template = styleTemplateInfo();
            return {
                ok: true,
                target: item.target,
                prompt: textboxValue(item.root),
                style_template_found: template.found,
                style_template: template.template
            };
        }
        if (name === "set_current_prompt") {
            const item = promptRootForTarget(args.target || "active");
            const prompt = String(args.prompt || "");
            if (!prompt.trim()) return { ok: false, error: "prompt is empty" };
            const ok = setTextboxValue(item.root, prompt);
            if (ok) switchMainTab(item.target);
            return { ok: ok, target: item.target, prompt: prompt };
        }
        if (name === "patch_current_prompt") {
            const item = promptRootForTarget(args.target || "active");
            const result = compactPromptPatchResult(patchPromptRoot(item.root, args.patch || args), Boolean(args.return_prompt));
            if (result.ok) switchMainTab(item.target);
            return Object.assign({ target: item.target }, result);
        }
        if (name === "multi_patch_current_prompt") {
            const item = promptRootForTarget(args.target || "active");
            const result = compactPromptPatchResult(patchPromptRoot(item.root, args.patches || []), Boolean(args.return_prompt));
            if (result.ok) switchMainTab(item.target);
            return Object.assign({ target: item.target }, result);
        }
        if (name === "get_style_template") {
            const template = styleTemplateInfo();
            return { ok: template.found, style_template: template.template, error: template.found ? "" : "style template field not found" };
        }
        if (name === "set_style_template") {
            const root = styleTemplateRoot();
            const template = String(args.template || "");
            if (!root) return { ok: false, error: "style template field not found" };
            if (!template.trim()) return { ok: false, error: "template is empty" };
            return { ok: setTextboxValue(root, template), style_template: template };
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
                prompt: userText || "",
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

    async function runAssistantLoop(userText, attachment) {
        const effectiveText = userText || (attachment ? "请根据附件例图分析构图和风格，帮助我整理提示词。" : "");
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
            for (let i = 0; i < 4; i += 1) {
                addAssistantMessage("status", "思考中...");
                const result = await callPromptAssistant();
                const text = result.text || "";
                const tool = parseAssistantTool(text);
                if (!tool) {
                    assistantState.messages.push({ role: "assistant", content: text });
                    addAssistantMessage("assistant", text);
                    return;
                }
                assistantState.messages.push({ role: "assistant", content: text });
                const toolResult = executeAssistantTool(tool);
                addAssistantMessage("tool", `工具 ${tool.tool || tool.name}: ${toolResult.ok ? "完成" : "失败"}`);
                assistantState.messages.push({ role: "user", content: `Tool result for ${tool.tool || tool.name}: ${JSON.stringify(toolResult)}` });
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

    function setupQwenTools() {
        if (!q3vlMainApp()) {
            removeAssistantWindow();
            return;
        }
        setupQwenPresetGate();
        setupSendButtons();
        setupAssistantWindow();
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
