(function () {
    const tools = window.q3vlPromptTools;
    if (!tools) return;
    const { assistantConfig, assistantPanel, assistantState, executeAssistantTool, tr } = tools;

    function t(key, fallback) {
        if (typeof tr !== "function") return fallback;
        const value = tr(key);
        return value && value !== key ? value : fallback;
    }

    const ASSISTANT_TOOL_NAMES = [
        "ask_teacher",
        "read_prompt",
        "get_current_prompt",
        "edit_prompt",
        "patch_current_prompt",
        "multi_patch_current_prompt",
        "set_current_prompt",
        "get_style_template",
        "set_style_template"
    ];

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
                return {};
            }
        }
        return typeof value === "object" && !Array.isArray(value) ? value : {};
    }

    function normalizeAssistantToolCall(call, inferredName) {
        if (!call || typeof call !== "object" || Array.isArray(call)) return null;
        const fn = call.function && typeof call.function === "object" ? call.function : null;
        const tool = assistantToolNameFromText(call.tool || call.name || (fn ? fn.name : "") || inferredName);
        if (!tool) return null;
        const hasExplicitArguments = call.arguments !== undefined || call.input !== undefined || call.args !== undefined || (fn && fn.arguments !== undefined);
        const rawArgs = call.arguments !== undefined ? call.arguments : call.input !== undefined ? call.input : call.args !== undefined ? call.args : fn ? fn.arguments : undefined;
        const args = hasExplicitArguments ? parseAssistantArguments(rawArgs) : inferredName ? call : {};
        return { tool: tool, arguments: args };
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
            return [];
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
        if (!log) return null;
        const item = document.createElement("div");
        item.className = `q3vl-assistant-msg q3vl-assistant-${role}`;
        if (role === "assistant" || role === "tool") {
            renderAssistantMarkdown(item, text);
        } else {
            item.textContent = text;
        }
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
        const log = assistantPanel()?.querySelector("#q3vl_assistant_messages");
        if (log) log.scrollTop = log.scrollHeight;
    }

    function addAssistantUserMessage(text, attachment) {
        const log = assistantPanel()?.querySelector("#q3vl_assistant_messages");
        if (!log) return;
        const rewindIndex = assistantState.messages.length;
        const item = document.createElement("div");
        item.className = "q3vl-assistant-msg q3vl-assistant-user";
        if (text) {
            const body = document.createElement("div");
            body.className = "q3vl-assistant-user-body";
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
        const rewindBtn = document.createElement("button");
        rewindBtn.type = "button";
        rewindBtn.className = "q3vl-assistant-rewind";
        rewindBtn.title = t("assistant.rewind", "编辑并重新发送");
        rewindBtn.setAttribute("aria-label", t("assistant.rewind", "编辑并重新发送"));
        rewindBtn.textContent = "✎";
        item.appendChild(rewindBtn);
        rewindBtn.addEventListener("click", function () {
            assistantState.messages.splice(rewindIndex);
            let node = item.nextElementSibling;
            while (node) {
                const next = node.nextElementSibling;
                node.remove();
                node = next;
            }
            item.remove();
            const input = assistantPanel()?.querySelector("#q3vl_assistant_input");
            if (input && text) {
                input.value = text;
                input.focus();
            }
            if (attachment) setAssistantAttachment(attachment);
        });
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
                vision_preset: config.vision_preset,
                vision_endpoint: config.vision_endpoint,
                vision_model: config.vision_model,
                vision_model_path: config.vision_model_path,
                vision_mmproj_path: config.vision_mmproj_path,
                enable_thinking: config.vision_thinking,
                n_ctx: config.n_ctx,
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
        hint.textContent = "本地 Qwen3.5 VLM 先分析/脱敏，再给 Gemini 教师";
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

    function formatAssistantTokenStatus(usage) {
        const input = Number(usage && usage.input_tokens) || 0;
        const output = Number(usage && usage.output_tokens) || 0;
        const thoughts = Number(usage && usage.thought_tokens) || 0;
        const suffix = thoughts > 0 ? ` thinking ${thoughts} tokens` : "";
        return `思考中... ↑${input} tokens ↓${output} tokens${suffix}`;
    }

    async function readPromptAssistantStream(response, onProgress) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let result = { text: "", tool_calls: [], usage: null };

        async function handleLine(line) {
            const raw = String(line || "").trim();
            if (!raw) return;
            const event = JSON.parse(raw);
            if (event.type === "error") throw new Error(event.error || "assistant stream failed");
            if (event.usage && typeof onProgress === "function") onProgress(event.usage);
            if (event.type === "delta") {
                result.text += event.text || "";
                return;
            }
            if (event.type === "done") {
                result = Object.assign({}, event, {
                    text: event.text !== undefined ? event.text : result.text,
                    tool_calls: Array.isArray(event.tool_calls) ? event.tool_calls : result.tool_calls,
                    usage: event.usage || result.usage
                });
            }
        }

        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) await handleLine(line);
        }
        buffer += decoder.decode();
        if (buffer.trim()) await handleLine(buffer);
        return result;
    }

    async function callPromptAssistant(onProgress) {
        const payload = Object.assign(assistantConfig(), { messages: assistantState.messages, stream: true });
        const streamResponse = await fetch("/qwen3vl-prompt-tools/assistant-stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        if (streamResponse.ok && streamResponse.body) {
            return await readPromptAssistantStream(streamResponse, onProgress);
        }
        if (streamResponse.status !== 404) {
            const detail = await streamResponse.text();
            throw new Error(detail);
        }

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
        const result = await response.json();
        if (result.usage && typeof onProgress === "function") onProgress(result.usage);
        return result;
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

    function assistantUserRequestedPromptEdit(text) {
        const value = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (!value) return false;
        const editVerb = /(改成|修改|改写|重写|优化|精炼|扩写|替换|追加|加上|加入|删除|移除|写入|更新|套用|应用|编辑|修一下|insert|append|replace|rewrite|edit|update|apply|change|remove|delete|optimi[sz]e|refine|expand)/i;
        const currentPromptRef = /(当前|现在|现有|原来|原有|这个|这段|它|其|提示词|prompt|txt2img|img2img|webui|ui|输入框|文本框)/i;
        const directEdit = /(帮我|请|直接|把|将|给我|给[\w\u4e00-\u9fff -]{1,40}).{0,30}(改成|修改|改写|重写|优化|精炼|扩写|替换|追加|加上|加入|删除|移除|写入|更新|套用|应用|编辑|修一下)/i;
        const adviceOnly = /(怎么改|如何改|哪里.*改|修改建议|改进建议|优化建议|建议.*(修改|优化|改写|调整)|should.*(change|edit|rewrite)|how.*(change|edit|rewrite))/i;
        return editVerb.test(value) && !adviceOnly.test(value) && (currentPromptRef.test(value) || directEdit.test(value));
    }

    function assistantToolMutatesPrompt(name) {
        return ["edit_prompt", "patch_current_prompt", "multi_patch_current_prompt"].includes(String(name || ""));
    }

    function assistantSupportsNativeImages(config) {
        const backend = String(config && config.backend || "");
        if (backend === "moyuu" && String(config && config.teacher_mode || "qwen-redact") === "qwen-redact") return true;
        const model = String(config && config.model || "").toLowerCase();
        const endpoint = String(config && config.endpoint || "");
        if (backend === "moyuu" || model.includes("gemini")) return true;
        try {
            const host = new URL(endpoint).hostname;
            return host === "moyuu.cc" || host.endsWith(".moyuu.cc");
        } catch (_error) {
            return false;
        }
    }

    async function runAssistantLoop(userText, attachment) {
        const effectiveText = userText || (attachment ? "请根据附件例图分析构图和风格，帮助我整理提示词。" : "");
        const mustEditPrompt = assistantUserRequestedPromptEdit(effectiveText);
        const config = assistantConfig();
        const nativeImage = attachment && assistantSupportsNativeImages(config);
        let userMessageSent = false;
        let promptEdited = false;
        let missingEditCorrectionSent = false;
        if (effectiveText || attachment) {
            addAssistantUserMessage(effectiveText, attachment);
        }
        const sendButton = assistantPanel()?.querySelector("#q3vl_assistant_send");
        if (sendButton) sendButton.disabled = true;
        try {
            if (attachment && nativeImage) {
                assistantState.messages.push({
                    role: "user",
                    content: effectiveText,
                    image: attachment.dataUrl,
                    filename: attachment.name || "reference image"
                });
                userMessageSent = true;
            } else if (attachment) {
                addAssistantMessage("status", "本地 VLM 正在分析附件...");
                const vision = await analyzeAssistantAttachment(attachment, effectiveText);
                const visionText = String(vision.text || "").trim();
                addAssistantMessage("tool", `视觉摘要 (${vision.vision_preset || vision.model || "local VLM"}${vision.thinking_enabled ? ", thinking" : ""}):\n${truncateAssistantText(visionText, 1200)}`);
                assistantState.messages.push({
                    role: "user",
                    content: `Reference image observation from local VLM (${vision.vision_preset || vision.model || "vision model"}, ${attachment.name || "image"}):\n${visionText}`
                });
            }
            if (effectiveText && !userMessageSent) {
                assistantState.messages.push({ role: "user", content: effectiveText });
            }
            for (let i = 0; i < 6; i += 1) {
                const statusItem = addAssistantMessage("status", "思考中... ↑0 tokens ↓0 tokens");
                const result = await callPromptAssistant(function (usage) {
                    updateAssistantMessage(statusItem, "status", formatAssistantTokenStatus(usage));
                });
                const text = result.text || "";
                const toolCalls = normalizeAssistantToolCalls(result, text);
                if (!toolCalls.length) {
                    if (!String(text || "").trim()) {
                        addAssistantMessage("error", "Gemini 返回了空内容，未检测到文本或工具调用。请重试；如果反复出现，降低 thinking/提高 Max tokens 或检查模型安全拦截。 ");
                        return;
                    }
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

    Object.assign(tools, {
        ASSISTANT_TOOL_NAMES,
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
        addAssistantUserMessage,
        truncateAssistantText,
        analyzeAssistantAttachment,
        setAssistantAttachment,
        renderAssistantAttachment,
        readAssistantImageFile,
        formatAssistantTokenStatus,
        readPromptAssistantStream,
        callPromptAssistant,
        normalizeAssistantToolCalls,
        assistantUserRequestedPromptEdit,
        assistantToolMutatesPrompt,
        assistantSupportsNativeImages,
        runAssistantLoop
    });
})();
