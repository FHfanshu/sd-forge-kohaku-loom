(function () {
    const tools = window.kohakuLoom;
    if (!tools) return;
    const { assistantConfig, assistantPanel, assistantState, resourceToolResultLabel, tr } = tools;
    function t(key, fallback) {
        if (typeof tr !== "function") return fallback;
        const value = tr(key);
        return value && value !== key ? value : fallback;
    }
    const ASSISTANT_TOOL_NAMES = [
        "ask_teacher",
        "read_prompt",
        "read_style_template",
        "get_current_prompt",
        "edit_prompt",
        "patch_current_prompt",
        "multi_patch_current_prompt",
        "set_current_prompt",
        "get_style_template",
        "set_style_template",
        "search_resources",
        "inspect_resource",
        "apply_resource",
        "initialize_prompt",
        "search_danbooru_tags",
        "inspect_danbooru_tag",
        "inspect_danbooru_tags",
        "related_danbooru_tags"
    ];
    const ASSISTANT_REPEATABLE_READ_TOOLS = new Set([
        "read_prompt",
        "read_style_template",
        "get_current_prompt",
        "get_style_template",
        "search_resources",
        "inspect_resource",
        "search_danbooru_tags",
        "inspect_danbooru_tag",
        "inspect_danbooru_tags",
        "related_danbooru_tags"
    ]);
    function assistantRepeatedToolAction(name, count) {
        if (count < 4) return "execute";
        if (count === 4) return "converge";
        return count >= 6 ? "stop" : "execute";
    }
    function assistantToolNameFromText(value) {
        const name = String(value || "").trim();
        return ASSISTANT_TOOL_NAMES.includes(name) ? name : "";
    }
    function parseAssistantArguments(value) {
        if (!value) return {};
        if (typeof value === "string") {
            try {
                const parsed = JSON.parse(value);
                return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
            } catch (_error) {
                const loose = parseAssistantLooseObject(value);
                return loose && typeof loose === "object" && !Array.isArray(loose) ? loose : {};
            }
        }
        return typeof value === "object" && !Array.isArray(value) ? value : {};
    }
    function parseAssistantLooseObject(value) {
        const raw = String(value || "").trim();
        if (!raw.startsWith("{") || !raw.endsWith("}")) return null;
        const jsonish = raw.replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":');
        try {
            return JSON.parse(jsonish);
        } catch (_error) {
            return null;
        }
    }
    function parseAssistantFunctionText(value) {
        const raw = String(value || "").trim();
        const match = raw.match(/^(?:call\s*:\s*)?([A-Za-z_][\w]*)\s*([\s\S]*)$/);
        if (!match) return [];
        const tool = assistantToolNameFromText(match[1]);
        if (!tool) return [];
        const rest = match[2].trim();
        return [{ tool: tool, arguments: rest ? parseAssistantArguments(rest) : {} }];
    }
    function normalizeAssistantToolCall(call, inferredName) {
        if (!call || typeof call !== "object" || Array.isArray(call)) return null;
        const fn = call.function && typeof call.function === "object" ? call.function : null;
        const tool = assistantToolNameFromText(call.tool || call.name || (fn ? fn.name : "") || inferredName);
        if (!tool) return null;
        const hasExplicitArguments = call.arguments !== undefined || call.input !== undefined || call.args !== undefined || (fn && fn.arguments !== undefined);
        const rawArgs = call.arguments !== undefined ? call.arguments : call.input !== undefined ? call.input : call.args !== undefined ? call.args : fn ? fn.arguments : undefined;
        const args = hasExplicitArguments ? parseAssistantArguments(rawArgs) : inferredName ? call : {};
        const normalized = { tool: tool, arguments: args };
        if (call.id) normalized.id = String(call.id);
        return normalized;
    }
    function collectAssistantToolCalls(parsed, inferredName) {
        if (!parsed) return [];
        if (Array.isArray(parsed)) {
            return parsed.flatMap(function (item) { return collectAssistantToolCalls(item, inferredName); });
        }
        if (typeof parsed !== "object") return [];
        if (Array.isArray(parsed.tool_calls)) {
            return parsed.tool_calls.flatMap(function (item) { return collectAssistantToolCalls(item, inferredName); });
        }
        if (parsed.function_call) {
            return collectAssistantToolCalls(parsed.function_call, inferredName);
        }
        const normalized = normalizeAssistantToolCall(parsed, inferredName);
        return normalized ? [normalized] : [];
    }
    function tryParseAssistantToolCalls(raw, inferredName) {
        try {
            return collectAssistantToolCalls(JSON.parse(String(raw || "").trim()), inferredName);
        } catch (_error) {
            const value = String(raw || "").trim();
            const loose = parseAssistantLooseObject(value);
            if (loose) return collectAssistantToolCalls(loose, inferredName);
            return parseAssistantFunctionText(value);
        }
    }
    function balancedJsonSegments(text, openChar, closeChar) {
        const value = String(text || "");
        const segments = [];
        let start = -1;
        let depth = 0;
        let inString = false;
        let escape = false;
        for (let i = 0; i < value.length; i += 1) {
            const char = value[i];
            if (inString) {
                if (escape) {
                    escape = false;
                } else if (char === "\\") {
                    escape = true;
                } else if (char === '"') {
                    inString = false;
                }
                continue;
            }
            if (char === '"') {
                inString = true;
                continue;
            }
            if (char === openChar) {
                if (depth === 0) start = i;
                depth += 1;
                continue;
            }
            if (char === closeChar && depth > 0) {
                depth -= 1;
                if (depth === 0 && start >= 0) {
                    segments.push({ text: value.slice(start, i + 1), start: start, end: i + 1 });
                    start = -1;
                }
            }
        }
        return segments;
    }
    function inferAssistantToolNameBefore(text, index) {
        const prefix = String(text || "").slice(Math.max(0, index - 180), index);
        let best = "";
        for (const name of ASSISTANT_TOOL_NAMES) {
            const pattern = new RegExp("(^|[^A-Za-z0-9_])" + name + "([^A-Za-z0-9_]|$)", "g");
            let match;
            while ((match = pattern.exec(prefix)) !== null) best = name;
        }
        return best;
    }
    function pushUniqueAssistantToolCalls(target, calls, seen) {
        for (const call of calls) {
            if (!call || !call.tool) continue;
            const key = `${call.tool}\u0000${JSON.stringify(call.arguments || {})}`;
            if (seen.has(key)) continue;
            seen.add(key);
            target.push(call);
        }
    }
    function parseAssistantTools(text) {
        let raw = String(text || "").trim();
        const result = [];
        const seen = new Set();
        raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        pushUniqueAssistantToolCalls(result, tryParseAssistantToolCalls(raw), seen);
        const fenced = String(text || "").matchAll(/```(?:json|tool|function)?\s*([\s\S]*?)```/gi);
        for (const match of fenced) {
            pushUniqueAssistantToolCalls(result, tryParseAssistantToolCalls(match[1]), seen);
        }
        const blocks = String(text || "").matchAll(/<tool_call[^>]*>([\s\S]*?)<\/tool_call>/gi);
        for (const match of blocks) {
            pushUniqueAssistantToolCalls(result, tryParseAssistantToolCalls(match[1]), seen);
        }
        const pipeBlocks = String(text || "").matchAll(/<\|tool_call\|?>([\s\S]*?)<tool_call\|>/gi);
        for (const match of pipeBlocks) {
            pushUniqueAssistantToolCalls(result, tryParseAssistantToolCalls(match[1]), seen);
        }
        for (const segment of balancedJsonSegments(text, "{", "}")) {
            const inferredName = inferAssistantToolNameBefore(text, segment.start);
            pushUniqueAssistantToolCalls(result, tryParseAssistantToolCalls(segment.text, inferredName), seen);
        }
        for (const segment of balancedJsonSegments(text, "[", "]")) {
            pushUniqueAssistantToolCalls(result, tryParseAssistantToolCalls(segment.text), seen);
        }
        return result;
    }
    function parseAssistantTool(text) {
        const calls = parseAssistantTools(text);
        return calls.length ? calls[0] : null;
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
        root.classList.add("loom-markdown");
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
        const log = assistantPanel()?.querySelector("#loom_assistant_messages");
        if (!log) return null;
        log.querySelector(".loom-assistant-empty")?.remove();
        const item = document.createElement("div");
        item.className = `loom-assistant-msg loom-assistant-${role}`;
        const roleLabels = {
            assistant: t("assistant.role.assistant", "助手"),
            error: t("assistant.role.error", "错误"),
            user: t("assistant.role.user", "你")
        };
        if (roleLabels[role]) item.dataset.loomRole = roleLabels[role];
        if (role === "assistant" || role === "tool") {
            renderAssistantMarkdown(item, text);
        } else {
            item.textContent = text;
        }
        if (role === "assistant") appendAssistantCopyAction(item, text);
        log.appendChild(item);
        log.scrollTop = log.scrollHeight;
        return item;
    }
    function updateAssistantMessage(item, role, text) {
        if (!item) return;
        if (role === "assistant" || role === "tool") {
            renderAssistantMarkdown(item, text);
        } else {
            item.textContent = text;
        }
        if (role === "assistant") appendAssistantCopyAction(item, text);
        const log = assistantPanel()?.querySelector("#loom_assistant_messages");
        if (log) log.scrollTop = log.scrollHeight;
    }

    function addAssistantUserMessage(text, attachment, inputText) {
        const log = assistantPanel()?.querySelector("#loom_assistant_messages");
        if (!log) return;
        log.querySelector(".loom-assistant-empty")?.remove();
        const item = document.createElement("div");
        item.className = "loom-assistant-msg loom-assistant-user";
        item.dataset.loomRole = t("assistant.role.user", "你");
        if (text) {
            const body = document.createElement("div");
            body.className = "loom-assistant-user-body";
            body.textContent = text;
            item.appendChild(body);
        }
        if (attachment) {
            const media = document.createElement("div");
            media.className = "loom-assistant-user-attachment";
            const image = document.createElement("img");
            image.src = attachment.dataUrl;
            image.alt = attachment.name || "reference image";
            const name = document.createElement("span");
            name.textContent = attachment.name || "reference image";
            media.appendChild(image);
            media.appendChild(name);
            item.appendChild(media);
        }
        const actions = document.createElement("div");
        actions.className = "loom-assistant-message-actions";
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "loom-assistant-message-edit";
        editBtn.title = t("assistant.rewind", "编辑并重新发送");
        editBtn.setAttribute("aria-label", t("assistant.rewind", "编辑并重新发送"));
        editBtn.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4 20 4.2-1 10.6-10.6a2.1 2.1 0 0 0-3-3L5.2 16zM13.8 7.3l3 3"/></svg>';
        editBtn.addEventListener("click", function () {
            const input = assistantPanel()?.querySelector("#loom_assistant_input");
            if (input && (inputText || text)) {
                input.value = inputText || text;
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.focus();
            }
            tools.setAssistantAttachments?.(attachment ? [attachment] : []);
        });
        actions.appendChild(editBtn);
        item.appendChild(actions);
        log.appendChild(item);
        log.scrollTop = log.scrollHeight;
    }

    function appendAssistantCopyAction(item, text) {
        if (!item || !String(text || "")) return;
        const actions = document.createElement("div");
        actions.className = "loom-assistant-message-actions";
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "loom-assistant-message-copy";
        copy.title = "复制回复";
        copy.setAttribute("aria-label", "复制回复");
        copy.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
        copy.addEventListener("click", async function () {
            try {
                await navigator.clipboard.writeText(String(text));
                copy.dataset.loomCopied = "1";
                copy.title = "已复制";
                window.setTimeout(function () {
                    delete copy.dataset.loomCopied;
                    copy.title = "复制回复";
                }, 1200);
            } catch (_error) {
                const selection = window.getSelection?.();
                const range = document.createRange?.();
                if (!selection || !range) return;
                range.selectNodeContents(item);
                selection.removeAllRanges();
                selection.addRange(range);
            }
        });
        actions.appendChild(copy);
        item.appendChild(actions);
    }
    function truncateAssistantText(text, limit) {
        const value = String(text || "").trim();
        return value.length > limit ? `${value.slice(0, limit)}...` : value;
    }

    async function analyzeAssistantAttachment(attachment, userText, run) {
        const config = assistantConfig();
        assertAssistantRunActive(run);
        const response = await fetch("/kohaku-loom/analyze-image", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: run?.controller.signal,
            body: JSON.stringify({
                image: attachment.dataUrl,
                filename: attachment.name,
                vision_preset: config.vision_preset,
                vision_endpoint: config.vision_endpoint,
                vision_model: config.vision_model,
                vision_model_path: config.vision_model_path,
                vision_mmproj_path: config.vision_mmproj_path,
                enable_thinking: config.vision_thinking,
                llama_server_path: config.llama_server_path,
                temperature: config.teacher_temperature,
                top_p: config.teacher_top_p,
                n_ctx: config.n_ctx,
                timeout: config.teacher_timeout
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
    function assistantAbortError() {
        return new Error("assistant run aborted");
    }
    function assertAssistantRunActive(run) {
        if (!run || run.cancelled || run.controller.signal.aborted) throw assistantAbortError();
    }
    function normalizeAssistantToolCalls(result, text) {
        const calls = Array.isArray(result.tool_calls) ? result.tool_calls : [];
        if (calls.length) {
            const normalized = [];
            pushUniqueAssistantToolCalls(normalized, calls.map(function (call) {
                return normalizeAssistantToolCall(call);
            }).filter(function (call) { return call && call.tool; }), new Set());
            return normalized;
        }
        return parseAssistantTools(text);
    }

    function assistantUserRequestedResourceMutation(text) {
        const value = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
        const action = /(应用|套用|加入|添加|插入|写入|使用|初始化|生成首版|填充|apply|add|insert|use|initiali[sz]e|fill)/i;
        const resource = /(wildcard|通配符|lora|style|styles|风格|预设|正面|负面|提示词|prompt)/i;
        const advice = /(怎么|如何|建议|说明|介绍|how|suggest|explain)/i;
        const question = /(吗[？?]?$|能不能|能否|是否|can you|is it possible)/i;
        const imperative = /(帮我|请|直接|把|将|给我|现在应用|go ahead|do it)/i;
        return action.test(value) && resource.test(value) && !advice.test(value) && (!question.test(value) || imperative.test(value));
    }

    function assistantToolResultLabel(name, result) {
        const resourceLabel = typeof resourceToolResultLabel === "function" ? resourceToolResultLabel(name, result) : "";
        if (resourceLabel) return resourceLabel;
        const status = result && result.ok ? "完成" : "失败";
        const error = result && result.error ? `: ${result.error}` : "";
        const target = result && result.target ? ` (${result.target})` : "";
        return `工具 ${name}${target}: ${status}${error}`;
    }

    function assistantSupportsNativeImages(config) {
        return Boolean(config && config.capabilities && config.capabilities.vision);
    }
    function assistantUsesGeminiVisionDelegateForAttachment(config) {
        if (typeof assistantUsesGeminiVisionDelegate === "function") return assistantUsesGeminiVisionDelegate(config);
        return String(config?.model_id || config?.model || "").toLowerCase().includes("grok");
    }
    Object.assign(tools, {
        ASSISTANT_TOOL_NAMES,
        assistantRepeatedToolAction,
        assistantToolNameFromText,
        parseAssistantArguments,
        normalizeAssistantToolCall,
        collectAssistantToolCalls,
        tryParseAssistantToolCalls,
        balancedJsonSegments,
        inferAssistantToolNameBefore,
        pushUniqueAssistantToolCalls,
        parseAssistantTools,
        parseAssistantTool,
        safeMarkdownHref,
        appendInlineMarkdown,
        appendInlineMarkdownWithBreaks,
        renderAssistantMarkdown,
        addAssistantMessage,
        updateAssistantMessage,
        appendAssistantCopyAction,
        addAssistantUserMessage,
        truncateAssistantText, assistantToolResultLabel, analyzeAssistantAttachment,
        normalizeAssistantToolCalls,
        assistantUserRequestedResourceMutation,
        assistantSupportsNativeImages,
        assistantUsesGeminiVisionDelegate: assistantUsesGeminiVisionDelegateForAttachment
    });
})();
