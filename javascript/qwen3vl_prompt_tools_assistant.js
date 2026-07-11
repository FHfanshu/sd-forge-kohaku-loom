(function () {
    const tools = window.q3vlPromptTools;
    if (!tools) return;
    const { assistantConfig, assistantPanel, assistantState, compactAssistantMessages, compactToolResult, ensureAutomaticPromptSkills, executeAssistantTool, resourceToolResultLabel, tr, analyzeAssistantAttachmentWithGemini, assistantUsesGeminiVisionDelegate, updateAssistantStreamingMessage } = tools;

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
        "set_style_template",
        "search_resources",
        "inspect_resource",
        "apply_resource",
        "initialize_prompt"
    ];
    const ASSISTANT_REPEATABLE_READ_TOOLS = new Set([
        "read_prompt",
        "get_current_prompt",
        "get_style_template",
        "search_resources",
        "inspect_resource"
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
        log.querySelector(".q3vl-assistant-empty")?.remove();
        const item = document.createElement("div");
        item.className = `q3vl-assistant-msg q3vl-assistant-${role}`;
        const roleLabels = {
            assistant: t("assistant.role.assistant", "助手"),
            error: t("assistant.role.error", "错误"),
            user: t("assistant.role.user", "你")
        };
        if (roleLabels[role]) item.dataset.q3vlRole = roleLabels[role];
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

    function addAssistantUserMessage(text, attachment, inputText) {
        const log = assistantPanel()?.querySelector("#q3vl_assistant_messages");
        if (!log) return;
        log.querySelector(".q3vl-assistant-empty")?.remove();
        const rewindIndex = assistantState.messages.length;
        const item = document.createElement("div");
        item.className = "q3vl-assistant-msg q3vl-assistant-user";
        item.dataset.q3vlRole = t("assistant.role.user", "你");
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
        rewindBtn.textContent = t("assistant.edit", "编辑");
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
            if (input && (inputText || text)) {
                input.value = inputText || text;
                input.dispatchEvent(new Event("input", { bubbles: true }));
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

    async function analyzeAssistantAttachment(attachment, userText, run) {
        const config = assistantConfig();
        assertAssistantRunActive(run);
        const response = await fetch("/qwen3vl-prompt-tools/analyze-image", {
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
        hint.textContent = "本地多模态模型先分析/脱敏，再给 Gemini 教师";
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
        const cached = Number(usage && usage.cached_tokens) || 0;
        const elapsed = Number(usage && usage.elapsed_ms) || 0;
        const speed = Number(usage && usage.tokens_per_second) || 0;
        const details = [];
        if (thoughts > 0) details.push(`thinking ${thoughts} tokens`);
        if (cached > 0) details.push(`cache ${cached} tokens`);
        else if (usage && usage.thinking_enabled === false) details.push("thinking off");
        if (usage && usage.stream === false) details.push("non-stream");
        if (elapsed > 0) details.push(`${(elapsed / 1000).toFixed(1)}s`);
        if (speed > 0) details.push(`${speed} tok/s`);
        const suffix = details.length ? ` (${details.join(", ")})` : "";
        return `思考中... ↑${input} tokens ↓${output} tokens${suffix}`;
    }
    function assistantInitialStatus(config) {
        if (String(config && config.runtime || "") === "llama-once") {
            return `本地模型一次性请求中... thinking ${config && config.local_text_thinking ? "on" : "off"}, non-stream`;
        }
        return "思考中... ↑0 tokens ↓0 tokens";
    }
    function assistantRunId() {
        return `q3vl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
    function assistantAbortError() {
        return new Error("assistant run aborted");
    }
    function assertAssistantRunActive(run) {
        if (!run || run.cancelled || run.controller.signal.aborted) throw assistantAbortError();
    }
    function setAssistantSendButtonRunning(button, running) {
        if (!button) return;
        button.disabled = false;
        const label = running ? t("assistant.stop", "终止") : t("assistant.send", "发送");
        button.setAttribute("aria-label", label);
        button.title = label;
        button.classList.toggle("q3vl-assistant-stop", Boolean(running));
        assistantPanel()?.querySelectorAll(".q3vl-assistant-runtime-control").forEach(function (control) { control.disabled = Boolean(running); });
    }
    function cancelAssistantRun() {
        const run = assistantState.running;
        if (!run || run.cancelled) return;
        run.cancelled = true;
        run.controller.abort();
        if (run.runtime !== "llama-once") return;
        fetch("/qwen3vl-prompt-tools/assistant-cancel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ run_id: run.id })
        }).catch(function () { });
    }

    async function readPromptAssistantStream(response, onProgress, run) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let result = { text: "", reasoning: "", tool_calls: [], usage: null };

        async function handleLine(line) {
            const raw = String(line || "").trim();
            if (!raw) return;
            const event = JSON.parse(raw);
            if (event.type === "error") throw new Error(event.error || "assistant stream failed");
            if (event.usage && typeof onProgress === "function") onProgress(event.usage);
            if (event.type === "delta") result.text += event.text || "";
            if (event.type === "reasoning_delta") result.reasoning += event.text || "";
            if (["delta", "reasoning_delta"].includes(event.type)) {
                if (typeof onProgress === "function") onProgress(event.usage || result.usage, { text: result.text, reasoning: result.reasoning });
                return;
            }
            if (event.type === "done") {
                result = Object.assign({}, result, event, {
                    text: event.text !== undefined ? event.text : result.text, reasoning: event.reasoning !== undefined ? event.reasoning : result.reasoning,
                    tool_calls: Array.isArray(event.tool_calls) ? event.tool_calls : result.tool_calls, usage: event.usage || result.usage
                });
            }
        }

        while (true) {
            assertAssistantRunActive(run);
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

    async function callPromptAssistant(onProgress, run) {
        assertAssistantRunActive(run);
        const config = assistantConfig();
        const payload = Object.assign(config, {
            messages: assistantState.messages,
            stream: config.capabilities?.streaming !== false,
            run_id: run?.id || "",
            disable_tools: Boolean(run?.disableTools)
        });
        const streamResponse = await fetch(payload.stream ? "/qwen3vl-prompt-tools/assistant-stream" : "/qwen3vl-prompt-tools/assistant", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: run?.controller.signal,
            body: JSON.stringify(payload)
        });
        if (payload.stream && streamResponse.ok && streamResponse.body) {
            return await readPromptAssistantStream(streamResponse, onProgress, run);
        }
        if (!payload.stream && streamResponse.ok) {
            const result = await streamResponse.json();
            if (result.usage && typeof onProgress === "function") onProgress(result.usage);
            return result;
        }
        if (streamResponse.status !== 404) {
            const detail = await streamResponse.text();
            throw new Error(detail);
        }

        const response = await fetch("/qwen3vl-prompt-tools/assistant", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: run?.controller.signal,
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
        const editVerb = /(改成|修改|改写|重写|优化|精炼|扩写|替换|追加|加上|加入|删除|移除|写入|更新|套用|应用|编辑|修一下|编写|创作|生成|制作|起草|insert|append|replace|rewrite|edit|update|apply|change|remove|delete|optimi[sz]e|refine|expand|write|create|generate|draft|compose)/i;
        const currentPromptRef = /(当前|现在|现有|原来|原有|这个|这段|它|其|提示词|prompt|txt2img|img2img|webui|ui|输入框|文本框)/i;
        const directEdit = /(帮我|请|直接|把|将|给我|给[\w\u4e00-\u9fff -]{1,40}).{0,30}(改成|修改|改写|重写|优化|精炼|扩写|替换|追加|加上|加入|删除|移除|写入|更新|套用|应用|编辑|修一下|编写|创作|生成|制作|起草)/i;
        const adviceOnly = /(怎么改|如何改|怎么写|如何写|哪里.*改|修改建议|改进建议|优化建议|写作建议|建议.*(修改|优化|改写|调整|编写)|should.*(change|edit|rewrite|write)|how.*(change|edit|rewrite|write))/i;
        return editVerb.test(value) && !adviceOnly.test(value) && (currentPromptRef.test(value) || directEdit.test(value));
    }

    function assistantToolMutatesPrompt(name) {
        return ["edit_prompt", "patch_current_prompt", "multi_patch_current_prompt", "apply_resource", "initialize_prompt"].includes(String(name || ""));
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
    async function runAssistantLoop(userText, attachment, displayText) {
        if (assistantState.running) {
            cancelAssistantRun();
            return;
        }
        const effectiveText = userText || (attachment ? "请根据附件例图分析构图和风格，帮助我整理提示词。" : "");
        const mustEditPrompt = assistantUserRequestedPromptEdit(effectiveText);
        const mutationAllowed = mustEditPrompt || assistantUserRequestedResourceMutation(effectiveText);
        const mustMutateUi = mustEditPrompt || mutationAllowed;
        const config = assistantConfig();
        const geminiVisionDelegate = attachment && assistantUsesGeminiVisionDelegateForAttachment(config);
        const nativeImage = attachment && !geminiVisionDelegate && assistantSupportsNativeImages(config);
        const run = { id: assistantRunId(), runtime: config.runtime, controller: new AbortController(), cancelled: false, turns: 0, toolCalls: 0, lastTool: "", repeatedTool: 0 };
        let userMessageSent = false;
        let promptEdited = false;
        let missingEditCorrectionSent = false;
        if (effectiveText || attachment) {
            addAssistantUserMessage(displayText === undefined ? effectiveText : displayText, attachment, effectiveText);
        }
        const sendButton = assistantPanel()?.querySelector("#q3vl_assistant_send");
        assistantState.running = run;
        assistantState.resourceMutationAllowed = mutationAllowed;
        setAssistantSendButtonRunning(sendButton, true);
        try {
            assertAssistantRunActive(run);
            if (attachment && nativeImage) {
                assistantState.messages.push({
                    role: "user",
                    content: effectiveText,
                    image: attachment.dataUrl,
                    filename: attachment.name || "reference image"
                });
                userMessageSent = true;
            } else if (attachment) {
                const visionStatus = addAssistantMessage("status", geminiVisionDelegate ? "Gemini 正在生成安全视觉摘要..." : "本地 VLM 正在分析附件...");
                let vision;
                try {
                    vision = geminiVisionDelegate
                        ? await analyzeAssistantAttachmentWithGemini(attachment, effectiveText, run)
                        : await analyzeAssistantAttachment(attachment, effectiveText, run);
                } finally {
                    visionStatus?.remove();
                }
                assertAssistantRunActive(run);
                const visionText = String(vision.text || "").trim();
                addAssistantMessage("tool", `视觉摘要 (${vision.vision_preset || vision.model || "local VLM"}${vision.thinking_enabled ? ", thinking" : ""}):\n${truncateAssistantText(visionText, 1200)}`);
                assistantState.messages.push({
                    role: "user",
                    content: `Reference image observation from ${geminiVisionDelegate ? "Gemini safety vision delegate" : "local VLM"} (${vision.vision_preset || vision.model || "vision model"}, ${attachment.name || "image"}):\n${visionText}`
                });
            }
            if (effectiveText && !userMessageSent) {
                assistantState.messages.push({ role: "user", content: effectiveText });
            }
            if (typeof ensureAutomaticPromptSkills === "function") {
                const loadedSkills = await ensureAutomaticPromptSkills(run);
                if (loadedSkills.length) addAssistantMessage("tool", `已自动加载指南 · ${loadedSkills.join(" · ")}`);
            }
            while (true) {
                assertAssistantRunActive(run);
                run.turns += 1;
                if (run.turns > 32) throw new Error("Agent loop 已达到 32 轮安全上限；当前 session 状态已保留，可继续执行。");
                if (typeof compactAssistantMessages === "function") assistantState.messages = compactAssistantMessages(assistantState.messages, 262144);
                const statusItem = addAssistantMessage("status", assistantInitialStatus(config)); let streamItem = null;
                let result;
                try {
                    result = await callPromptAssistant(function (usage, partial) {
                        if (usage) updateAssistantMessage(statusItem, "status", formatAssistantTokenStatus(usage));
                        if (!partial || (!partial.text && !partial.reasoning)) return;
                        if (!streamItem) streamItem = addAssistantMessage("assistant", "");
                        updateAssistantStreamingMessage(streamItem, partial.text, partial.reasoning, renderAssistantMarkdown);
                    }, run);
                } catch (error) {
                    statusItem?.remove();
                    throw error;
                }
                statusItem?.remove();
                assertAssistantRunActive(run);
                const text = result.text || "";
                const reasoning = result.reasoning || "";
                if (streamItem) updateAssistantStreamingMessage(streamItem, text, reasoning, renderAssistantMarkdown);
                const toolCalls = normalizeAssistantToolCalls(result, text);
                if (toolCalls.length > 64) throw new Error("模型单轮生成了超过 64 个工具调用，疑似异常批量响应，已暂停执行。");
                if (!toolCalls.length) {
                    if (!String(text || "").trim()) {
                        addAssistantMessage("error", "Gemini 返回了空内容，未检测到文本或工具调用。请重试；如果反复出现，降低 thinking/提高 Max tokens 或检查模型安全拦截。 ");
                        return;
                    }
                    if (mustMutateUi && !promptEdited) {
                        assistantState.messages.push({ role: "assistant", content: text || "No tool call returned." });
                        if (!missingEditCorrectionSent) {
                            missingEditCorrectionSent = true;
                            addAssistantMessage("tool", "未检测到写入工具，继续要求助手实际修改当前界面...");
                            assistantState.messages.push({
                                role: "user",
                                content: "The user explicitly asked to change the current WebUI state. Do not claim success until edit_prompt, apply_resource, or initialize_prompt succeeds. Call read_prompt first and use its latest hash/context_hash."
                            });
                            continue;
                        }
                        addAssistantMessage("error", "助手没有成功调用写入工具，当前界面未被修改。请重试。");
                        return;
                    }
                    assistantState.messages.push({ role: "assistant", content: text });
                    if (!streamItem) streamItem = addAssistantMessage("assistant", "");
                    updateAssistantStreamingMessage(streamItem, text, reasoning, renderAssistantMarkdown);
                    return;
                }
                assistantState.messages.push({
                    role: "assistant",
                    content: text || "",
                    tool_calls: toolCalls.map(function (call, index) {
                        return {
                            id: call.id || `call_${run.turns}_${index}`,
                            type: "function",
                            function: { name: call.tool, arguments: JSON.stringify(call.arguments || {}) }
                        };
                    })
                });
                for (const [toolIndex, tool] of toolCalls.entries()) {
                    assertAssistantRunActive(run);
                    const toolName = tool.tool || tool.name;
                    run.toolCalls += 1;
                    const signature = `${toolName}\u0000${JSON.stringify(tool.arguments || {})}`;
                    run.repeatedTool = signature === run.lastTool ? run.repeatedTool + 1 : 1;
                    run.lastTool = signature;
                    const repeatedAction = assistantRepeatedToolAction(toolName, run.repeatedTool);
                    if (repeatedAction === "stop") throw new Error(`模型连续重复调用工具 ${toolName}，已停止以避免无进展循环。`);
                    const toolResult = await executeAssistantTool(tool, run.controller.signal);
                    assertAssistantRunActive(run);
                    if (assistantToolMutatesPrompt(toolName) && toolResult.ok) promptEdited = true;
                    addAssistantMessage("tool", assistantToolResultLabel(toolName, toolResult));
                    const serialized = typeof compactToolResult === "function" ? compactToolResult(toolResult, 64000) : JSON.stringify(toolResult);
                    let toolMessage = `Tool result for ${toolName}: ${serialized}`;
                    const emptyPrompt = ["read_prompt", "get_current_prompt"].includes(toolName) && toolResult.ok && !String(toolResult.positive_prompt ?? toolResult.prompt ?? "").trim();
                    if (emptyPrompt && mustMutateUi) toolMessage += "\nThe current positive prompt is empty. Do not call read_prompt again and do not ask for existing prompt content. Based on the user's original request, write a complete production-ready prompt now, then call edit_prompt for field positive with operation append and the latest positive_prompt_hash/prompt_hash as base_hash.";
                    if (repeatedAction === "converge") {
                        if (mustMutateUi) {
                            toolMessage += "\nThis read-only result is current and has already been returned twice. Do not read it again. Use its latest hashes to call the required write tool now.";
                        } else {
                            run.disableTools = true;
                            toolMessage += "\nThis read-only result is current and has already been returned twice. Do not call another tool. Answer the user's original request naturally using this result.";
                        }
                    }
                    const toolCallId = tool.id || assistantState.messages[assistantState.messages.length - 1]?.tool_calls?.[toolIndex]?.id;
                    assistantState.messages.push(toolCallId
                        ? { role: "tool", tool_call_id: toolCallId, content: toolMessage }
                        : { role: "user", content: toolMessage });
                }
            }
        } catch (error) {
            const message = String(error && error.message || error);
            if (run.cancelled || run.controller.signal.aborted || error?.name === "AbortError" || message === "assistant run aborted") {
                addAssistantMessage("status", "已终止。")?.classList.add("q3vl-assistant-status-static");
            } else {
                addAssistantMessage("error", message);
            }
        } finally {
            if (assistantState.running === run) assistantState.running = null;
            assistantState.resourceMutationAllowed = false;
            setAssistantSendButtonRunning(sendButton, false);
        }
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
        addAssistantUserMessage,
        truncateAssistantText, renderAssistantMarkdown, assistantToolResultLabel,
        analyzeAssistantAttachment,
        setAssistantAttachment,
        renderAssistantAttachment,
        readAssistantImageFile,
        cancelAssistantRun,
        formatAssistantTokenStatus,
        readPromptAssistantStream,
        callPromptAssistant,
        normalizeAssistantToolCalls,
        assistantUserRequestedPromptEdit,
        assistantUserRequestedResourceMutation,
        assistantToolMutatesPrompt,
        assistantSupportsNativeImages,
        assistantUsesGeminiVisionDelegate: assistantUsesGeminiVisionDelegateForAttachment,
        runAssistantLoop
    });
})();
