(function () {
    const tools = window.q3vlPromptTools;
    if (!tools) return;

    const SESSION_KEY = "q3vl_assistant_active_session";
    const BASE = "/qwen3vl-prompt-tools/assistant";

    function activeSessionId() {
        return localStorage.getItem(SESSION_KEY) || "";
    }

    function setActiveSessionId(sessionId) {
        if (sessionId) localStorage.setItem(SESSION_KEY, sessionId);
        else localStorage.removeItem(SESSION_KEY);
        tools.assistantState.sessionId = sessionId || "";
    }

    async function sessionRequest(path, options) {
        const response = await fetch(BASE + path, options);
        if (!response.ok) throw new Error(await response.text());
        return response.status === 204 ? null : response;
    }

    async function ensureAssistantSession(config) {
        let sessionId = activeSessionId();
        if (sessionId) {
            try {
                await sessionRequest(`/sessions/${encodeURIComponent(sessionId)}`);
                tools.assistantState.sessionId = sessionId;
                return sessionId;
            } catch (_error) {
                setActiveSessionId("");
            }
        }
        const response = await sessionRequest("/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ profile_id: config.profile_id || "", model_snapshot: sessionSnapshot(config) })
        });
        const session = await response.json();
        setActiveSessionId(session.session_id);
        return session.session_id;
    }

    function sessionSnapshot(config) {
        const copy = Object.assign({}, config);
        ["api_key", "authorization", "headers", "messages", "image", "data_url"].forEach(function (key) { delete copy[key]; });
        return copy;
    }

    async function createSessionRun(sessionId, run, config, messages) {
        const response = await sessionRequest(`/sessions/${encodeURIComponent(sessionId)}/runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(Object.assign({}, config, {
                messages: messages,
                profile_id: config.profile_id || "",
                lease_owner: run.id
            }))
        });
        const result = await response.json();
        run.sessionId = sessionId;
        run.sessionRunId = result.run_id;
        return result;
    }

    async function resumeSessionRun(run) {
        const response = await sessionRequest(`/runs/${encodeURIComponent(run.sessionRunId)}/resume`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lease_owner: run.id })
        });
        return response.json();
    }

    async function recordSessionToolResult(run, tool, result) {
        const response = await sessionRequest(`/runs/${encodeURIComponent(run.sessionRunId)}/tool-results`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                tool_call_id: tool.id || "",
                tool: tool.tool || tool.name || "",
                arguments: tool.arguments || {},
                result: result,
                content: JSON.stringify(result)
            })
        });
        return response.json();
    }

    async function sessionStream(run, config, onProgress) {
        const response = await sessionRequest(`/runs/${encodeURIComponent(run.sessionRunId)}/stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: run.controller.signal,
            body: JSON.stringify(Object.assign({}, config, { run_id: run.id, stream: true }))
        });
        return tools.readPromptAssistantStream(response, onProgress, run);
    }

    function setSendRunning(button, running) {
        if (!button) return;
        button.disabled = false;
        button.classList.toggle("q3vl-assistant-stop", Boolean(running));
        button.title = running ? "终止" : "发送";
        button.setAttribute("aria-label", button.title);
        tools.assistantPanel()?.querySelectorAll(".q3vl-assistant-runtime-control").forEach(function (control) { control.disabled = Boolean(running); });
    }

    function assertRunning(run) {
        if (!run || run.cancelled || run.controller.signal.aborted) throw new Error("assistant run aborted");
    }

    async function executeSessionTools(run, calls) {
        run.turnId = (run.turnId || 0) + 1;
        for (const [index, tool] of calls.entries()) {
            assertRunning(run);
            tool.id = tool.id || `call_${run.turnId}_${index}`;
            const result = await tools.executeAssistantTool(tool, run.controller.signal);
            await recordSessionToolResult(run, tool, result);
            tools.addAssistantMessage("tool", tools.assistantToolResultLabel ? tools.assistantToolResultLabel(tool.tool, result) : `工具 ${tool.tool}: ${result.ok ? "完成" : "失败"}`);
        }
    }

    async function continueSessionRun(run, config, pendingCalls) {
        if (pendingCalls?.length) {
            await executeSessionTools(run, pendingCalls);
            await resumeSessionRun(run);
        }
        while (true) {
            assertRunning(run);
            const status = tools.addAssistantMessage("status", "思考中...");
            let streamed = null;
            const result = await sessionStream(run, config, function (usage, partial) {
                if (usage) tools.updateAssistantMessage(status, "status", tools.formatAssistantTokenStatus(usage));
                if (!partial || (!partial.text && !partial.reasoning)) return;
                if (!streamed) streamed = tools.addAssistantMessage("assistant", "");
                tools.updateAssistantStreamingMessage(streamed, partial.text, partial.reasoning, tools.renderAssistantMarkdown);
            });
            status?.remove();
            assertRunning(run);
            const output = String(result.text || "");
            const calls = tools.normalizeAssistantToolCalls(result, output);
            if (!calls.length) {
                if (!streamed) tools.addAssistantMessage("assistant", output || "");
                return;
            }
            await executeSessionTools(run, calls);
            await resumeSessionRun(run);
        }
    }

    async function runAssistantSessionLoop(userText, attachment, displayText) {
        const state = tools.assistantState;
        if (state.running) {
            cancelAssistantSessionRun();
            return;
        }
        const text = userText || (attachment ? "请根据附件例图分析构图和风格，帮助我整理提示词。" : "");
        const config = tools.assistantConfig();
        const run = { id: `q3vl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, controller: new AbortController(), cancelled: false };
        const initialMessages = [];
        const sendButton = tools.assistantPanel()?.querySelector("#q3vl_assistant_send");
        state.running = run;
        setSendRunning(sendButton, true);
        try {
            if (text || attachment) tools.addAssistantUserMessage(displayText === undefined ? text : displayText, attachment, text);
            if (attachment) {
                const nativeImage = tools.assistantSupportsNativeImages(config) && !tools.assistantUsesGeminiVisionDelegate(config);
                if (nativeImage) initialMessages.push({ role: "user", content: text, image: attachment.dataUrl, filename: attachment.name || "reference image" });
                else {
                    const status = tools.addAssistantMessage("status", "正在分析附件...");
                    const vision = tools.assistantUsesGeminiVisionDelegate(config)
                        ? await tools.analyzeAssistantAttachmentWithGemini(attachment, text, run)
                        : await tools.analyzeAssistantAttachment(attachment, text, run);
                    status?.remove();
                    const summary = String(vision.text || "").trim();
                    tools.addAssistantMessage("tool", `视觉摘要 (${vision.vision_preset || vision.model || "vision model"}):\n${tools.truncateAssistantText(summary, 1200)}`);
                    initialMessages.push({ role: "user", content: `Reference image observation (${attachment.name || "image"}):\n${summary}` });
                }
            }
            if (text) initialMessages.push({ role: "user", content: text });
            if (!initialMessages.length) return;
            const sessionId = await ensureAssistantSession(config);
            await createSessionRun(sessionId, run, config, initialMessages);
            await continueSessionRun(run, config);
        } catch (error) {
            const message = String(error?.message || error);
            if (run.cancelled || run.controller.signal.aborted || message === "assistant run aborted") {
                tools.addAssistantMessage("status", "已终止。");
            } else {
                tools.addAssistantMessage("error", message);
            }
        } finally {
            if (state.running === run) state.running = null;
            setSendRunning(sendButton, false);
        }
    }

    function cancelAssistantSessionRun() {
        const run = tools.assistantState.running;
        if (!run || run.cancelled) return;
        run.cancelled = true;
        run.controller.abort();
        if (run.sessionRunId) fetch(`${BASE}/runs/${encodeURIComponent(run.sessionRunId)}/cancel`, { method: "POST" }).catch(function () { });
    }

    function renderPersistedEvent(event) {
        const payload = event.payload || {};
        if (event.event_type === "user_message") tools.addAssistantMessage("user", payload.content || "");
        if (event.event_type === "assistant_message") tools.addAssistantMessage("assistant", payload.content || "");
        if (event.event_type === "tool_result") tools.addAssistantMessage("tool", `工具 ${payload.tool || ""}: ${payload.result?.ok ? "完成" : "已记录"}`);
        if (event.event_type === "error") tools.addAssistantMessage("error", payload.error || "assistant error");
    }

    async function restoreAssistantSession() {
        const panel = tools.assistantPanel?.();
        const sessionId = activeSessionId();
        if (!panel || !sessionId || panel.dataset.q3vlSessionRestored === sessionId) return;
        try {
            const response = await sessionRequest(`/sessions/${encodeURIComponent(sessionId)}`);
            const data = await response.json();
            const log = panel.querySelector("#q3vl_assistant_messages");
            if (!log) return;
            log.replaceChildren();
            data.events.forEach(renderPersistedEvent);
            panel.dataset.q3vlSessionRestored = sessionId;
            tools.assistantState.sessionId = sessionId;
            await resumePersistedToolCalls(data);
        } catch (_error) {
            setActiveSessionId("");
        }
    }

    async function resumePersistedToolCalls(data) {
        const session = data.session || {};
        if (session.state !== "waiting" || !session.active_run_id || tools.assistantState.running) return;
        const events = Array.isArray(data.events) ? data.events : [];
        const completed = new Set(events.filter(function (event) { return event.event_type === "tool_result"; }).map(function (event) {
            return String(event.payload?.tool_call_id || "");
        }));
        const pendingEvent = [...events].reverse().find(function (event) {
            return event.event_type === "assistant_message" && Array.isArray(event.payload?.tool_calls) && event.payload.tool_calls.length;
        });
        const calls = pendingEvent ? pendingEvent.payload.tool_calls.filter(function (call) { return !completed.has(String(call.id || "")); }) : [];
        if (!calls.length) return;
        const config = tools.assistantConfig();
        const run = {
            id: `q3vl-resume-${Date.now().toString(36)}`,
            sessionId: session.session_id,
            sessionRunId: session.active_run_id,
            controller: new AbortController(),
            cancelled: false,
            turnId: Math.max(0, ...events.map(function (event) { return Number(event.turn_id) || 0; }))
        };
        const sendButton = tools.assistantPanel()?.querySelector("#q3vl_assistant_send");
        tools.assistantState.running = run;
        setSendRunning(sendButton, true);
        try {
            await continueSessionRun(run, config, calls);
        } catch (error) {
            tools.addAssistantMessage("error", String(error?.message || error));
        } finally {
            if (tools.assistantState.running === run) tools.assistantState.running = null;
            setSendRunning(sendButton, false);
        }
    }

    async function resetAssistantSession() {
        const sessionId = activeSessionId();
        setActiveSessionId("");
        if (!sessionId) return;
        await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch(function () { });
    }

    async function createAssistantSession() {
        if (tools.assistantState.running) return;
        const config = tools.assistantConfig();
        const response = await sessionRequest("/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ profile_id: config.profile_id || "", model_snapshot: sessionSnapshot(config) })
        });
        const session = await response.json();
        setActiveSessionId(session.session_id);
        const panel = tools.assistantPanel?.();
        const log = panel?.querySelector("#q3vl_assistant_messages");
        if (log) log.replaceChildren();
        if (panel) panel.dataset.q3vlSessionRestored = session.session_id;
    }

    async function openAssistantSessionHistory() {
        const panel = tools.assistantPanel?.();
        if (!panel) return;
        panel.querySelector("#q3vl_assistant_session_menu")?.remove();
        const response = await sessionRequest("/sessions?limit=30");
        const data = await response.json();
        const menu = document.createElement("div");
        menu.id = "q3vl_assistant_session_menu";
        menu.className = "q3vl-assistant-session-menu";
        menu.hidden = false;
        (data.sessions || []).forEach(function (session) {
            const item = document.createElement("button");
            item.type = "button";
            item.textContent = `${session.title || "New session"} · ${session.state}`;
            item.setAttribute("aria-selected", String(session.session_id === activeSessionId()));
            item.addEventListener("click", function () {
                setActiveSessionId(session.session_id);
                panel.dataset.q3vlSessionRestored = "";
                panel.querySelector("#q3vl_assistant_messages")?.replaceChildren();
                menu.remove();
                restoreAssistantSession();
            });
            menu.appendChild(item);
        });
        if (!menu.childElementCount) menu.textContent = "No saved sessions";
        panel.querySelector(".q3vl-assistant-head")?.appendChild(menu);
    }

    Object.assign(tools, {
        ensureAssistantSession,
        runAssistantSessionLoop,
        cancelAssistantSessionRun,
        restoreAssistantSession,
        resetAssistantSession,
        createAssistantSession,
        openAssistantSessionHistory
    });
})();
