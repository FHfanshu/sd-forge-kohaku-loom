(function () {
    const tools = window.q3vlPromptTools;
    if (!tools) return;

    const SESSION_KEY = "q3vl_assistant_active_session";
    const BASE = "/qwen3vl-prompt-tools/assistant";
    let restorePromise = null;
    let restoreSessionId = "";
    let sessionGeneration = 0;
    tools.assistantState.durableSessions = true;

    function activeSessionId() {
        return localStorage.getItem(SESSION_KEY) || "";
    }

    function setActiveSessionId(sessionId) {
        if (sessionId) localStorage.setItem(SESSION_KEY, sessionId);
        else localStorage.removeItem(SESSION_KEY);
        tools.assistantState.sessionId = sessionId || "";
        sessionGeneration += 1;
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

    function assistantSessionListPath(query) {
        const value = String(query || "").trim();
        return `/sessions?limit=30${value ? `&query=${encodeURIComponent(value)}` : ""}`;
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

    async function prepareSessionTool(run, tool) {
        const response = await sessionRequest(`/runs/${encodeURIComponent(run.sessionRunId)}/tool-calls/${encodeURIComponent(tool.id)}/start`, {
            method: "POST"
        });
        return response.json();
    }

    async function sessionStream(run, config, onProgress) {
        const response = await sessionRequest(`/runs/${encodeURIComponent(run.sessionRunId)}/stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: run.controller.signal,
            body: JSON.stringify(Object.assign({}, config, { lease_owner: run.id, stream: true }))
        });
        return tools.readPromptAssistantStream(response, onProgress, run);
    }

    function setSendRunning(button, running) {
        if (!button) return;
        button.disabled = false;
        button.title = "发送";
        button.setAttribute("aria-label", "发送");
        const stop = tools.assistantPanel()?.querySelector("#q3vl_assistant_stop");
        if (stop) stop.hidden = !running;
        tools.assistantPanel()?.querySelectorAll(".q3vl-assistant-runtime-control").forEach(function (control) { control.disabled = Boolean(running); });
    }

    function assertRunning(run) {
        if (!run || run.cancelled || run.controller.signal.aborted) throw new Error("assistant run aborted");
    }

    async function executeSessionTools(run, calls) {
        run.turnId = (run.turnId || 0) + 1;
        tools.assistantState.resourceMutationAllowed = Boolean(run.resourceMutationAllowed);
        for (const [index, tool] of calls.entries()) {
            assertRunning(run);
            tool.id = tool.id || `call_${run.turnId}_${index}`;
            const preparation = await prepareSessionTool(run, tool);
            if (preparation.next_action === "replan") return "replan";
            if (preparation.next_action === "skip") continue;
            const result = await tools.executeAssistantTool(tool, run.controller.signal);
            const recorded = await recordSessionToolResult(run, tool, result);
            tools.addAssistantMessage("tool", tools.assistantToolResultLabel ? tools.assistantToolResultLabel(tool.tool, result) : `工具 ${tool.tool}: ${result.ok ? "完成" : "失败"}`);
            if (recorded.next_action === "replan") return "replan";
        }
        return "continue";
    }

    async function awaitFollowupPreparation(run) {
        let work;
        do {
            work = run.followupWork;
            if (work) await work;
        } while (work !== run.followupWork);
        run.followupQueued = false;
    }

    async function continueSessionRun(run, config, pendingCalls) {
        if (pendingCalls?.length) {
            const action = await executeSessionTools(run, pendingCalls);
            if (action === "replan") await awaitFollowupPreparation(run);
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
            if (result.checkpoint?.next_action === "replan") {
                await awaitFollowupPreparation(run);
                await resumeSessionRun(run);
                continue;
            }
            if (!calls.length) {
                if (!streamed) tools.addAssistantMessage("assistant", output || "");
                if (run.followupQueued) {
                    await awaitFollowupPreparation(run);
                    await resumeSessionRun(run);
                    continue;
                }
                return;
            }
            const action = await executeSessionTools(run, calls);
            if (action === "replan") await awaitFollowupPreparation(run);
            await resumeSessionRun(run);
        }
    }

    async function runAssistantSessionLoop(userText, attachment, displayText) {
        const state = tools.assistantState;
        if (state.running) {
            return queueAssistantFollowup(userText, attachment, displayText);
        }
        const attachments = tools.normalizedAssistantAttachments?.(attachment) || (attachment ? [attachment] : []);
        const text = userText || (attachments.length ? "请根据附件例图分析构图和风格，帮助我整理提示词。" : "");
        const config = tools.assistantConfig();
        const mutationAllowed = Boolean(tools.assistantUserRequestedPromptEdit?.(text) || tools.assistantUserRequestedResourceMutation?.(text));
        const run = { id: `q3vl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, controller: new AbortController(), cancelled: false, resourceMutationAllowed: mutationAllowed };
        run.ready = new Promise(function (resolve, reject) { run.resolveReady = resolve; run.rejectReady = reject; });
        const initialMessages = [];
        const sendButton = tools.assistantPanel()?.querySelector("#q3vl_assistant_send");
        state.running = run;
        setSendRunning(sendButton, true);
        try {
            if (text || attachments.length) tools.addAssistantUserMessage(displayText === undefined ? text : displayText, attachments, text);
            if (attachments.length) {
                const nativeImage = tools.assistantSupportsNativeImages(config) && !tools.assistantUsesGeminiVisionDelegate(config);
                if (nativeImage) attachments.forEach(function (item, index) {
                    initialMessages.push({ role: "user", content: index === 0 ? text : `Reference image ${index + 1}`, image: item.dataUrl, filename: item.name || `reference image ${index + 1}` });
                });
                else {
                    const status = tools.addAssistantMessage("status", "正在分析附件...");
                    const summaries = [];
                    for (const [index, item] of attachments.entries()) {
                        const vision = tools.assistantUsesGeminiVisionDelegate(config)
                            ? await tools.analyzeAssistantAttachmentWithGemini(item, text, run)
                            : await tools.analyzeAssistantAttachment(item, text, run);
                        summaries.push(`Reference image ${index + 1} (${item.name || "image"}):\n${String(vision.text || "").trim()}`);
                    }
                    status?.remove();
                    initialMessages.push({ role: "user", content: `${text}\n\n${summaries.join("\n\n")}`.trim() });
                }
            }
            if (text && !attachments.length) initialMessages.push({ role: "user", content: text });
            if (!initialMessages.length) return;
            const sessionId = await ensureAssistantSession(config);
            await createSessionRun(sessionId, run, config, initialMessages);
            run.resolveReady();
            await continueSessionRun(run, config);
        } catch (error) {
            if (!run.sessionRunId) run.rejectReady(error);
            const message = String(error?.message || error);
            if (run.cancelled || run.controller.signal.aborted || message === "assistant run aborted") {
                tools.addAssistantMessage("status", "已终止。");
            } else {
                tools.addAssistantMessage("error", message);
            }
        } finally {
            if (state.running === run) state.running = null;
            state.resourceMutationAllowed = false;
            setSendRunning(sendButton, false);
        }
    }

    async function postFollowupMessages(run, messages) {
        const response = await sessionRequest(`/runs/${encodeURIComponent(run.sessionRunId)}/followups`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: messages })
        });
        return response.json();
    }

    function queueAssistantFollowup(userText, attachment, displayText) {
        const run = tools.assistantState.running;
        if (!run) return Promise.reject(new Error("当前没有可跟进的 Agent 运行。"));
        const attachments = tools.normalizedAssistantAttachments?.(attachment) || (attachment ? [attachment] : []);
        const text = String(userText || "").trim();
        if (!text && !attachments.length) return Promise.resolve();
        tools.addAssistantUserMessage(displayText === undefined ? text : displayText, attachments, text);
        run.followupQueued = true;
        const previous = run.followupWork || Promise.resolve();
        run.followupWork = previous.then(async function () {
            if (!run.sessionRunId) await run.ready;
            const config = tools.assistantConfig();
            const nativeImage = attachments.length && tools.assistantSupportsNativeImages(config) && !tools.assistantUsesGeminiVisionDelegate(config);
            if (nativeImage) {
                const messages = attachments.map(function (item, index) {
                    return { role: "user", content: index === 0 ? text : `Reference image ${index + 1}`, image: item.dataUrl, filename: item.name || `reference image ${index + 1}` };
                });
                await postFollowupMessages(run, messages);
                return;
            }
            await postFollowupMessages(run, [{ role: "user", content: text || "The user added reference images; detailed observations follow." }]);
            if (!attachments.length) return;
            const summaries = [];
            for (const [index, item] of attachments.entries()) {
                const vision = tools.assistantUsesGeminiVisionDelegate(config)
                    ? await tools.analyzeAssistantAttachmentWithGemini(item, text, run)
                    : await tools.analyzeAssistantAttachment(item, text, run);
                summaries.push({ role: "user", content: `Reference image ${index + 1} (${item.name || "image"}):\n${String(vision.text || "").trim()}` });
            }
            await postFollowupMessages(run, summaries);
        }).catch(function (error) {
            run.followupQueued = false;
            tools.addAssistantMessage("error", String(error?.message || error));
        });
        return run.followupWork;
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
        if (event.event_type === "user_message" && !payload.followup_event_id) tools.addAssistantUserMessage(payload.content || "", payload.image ? [{ dataUrl: payload.image, name: payload.filename || "reference image" }] : []);
        if (event.event_type === "user_followup_queued") {
            const message = payload.message || {};
            tools.addAssistantUserMessage(message.content || "", message.image ? [{ dataUrl: message.image, name: message.filename || "reference image" }] : []);
        }
        if (event.event_type === "assistant_message") tools.addAssistantMessage("assistant", payload.content || "");
        if (event.event_type === "tool_result") tools.addAssistantMessage("tool", `工具 ${payload.tool || ""}: ${payload.result?.ok ? "完成" : "已记录"}`);
        if (event.event_type === "error") tools.addAssistantMessage("error", payload.error || "assistant error");
    }

    async function restoreAssistantSession() {
        const panel = tools.assistantPanel?.();
        const sessionId = activeSessionId();
        if (!panel || !sessionId || panel.dataset.q3vlSessionRestored === sessionId) return;
        if (restorePromise && restoreSessionId === sessionId) return restorePromise;
        const generation = sessionGeneration;
        restoreSessionId = sessionId;
        restorePromise = (async function () {
            try {
                const response = await sessionRequest(`/sessions/${encodeURIComponent(sessionId)}`);
                const data = await response.json();
                if (generation !== sessionGeneration || activeSessionId() !== sessionId) return;
                const log = panel.querySelector("#q3vl_assistant_messages");
                if (!log) return;
                log.replaceChildren();
                if (data.session?.summary) tools.addAssistantMessage("tool", "较早会话已压缩为上下文摘要");
                data.events.forEach(renderPersistedEvent);
                panel.dataset.q3vlSessionRestored = sessionId;
                tools.assistantState.sessionId = sessionId;
                await resumePersistedToolCalls(data);
            } catch (_error) {
                if (generation === sessionGeneration && activeSessionId() === sessionId) setActiveSessionId("");
            } finally {
                if (restoreSessionId === sessionId) {
                    restorePromise = null;
                    restoreSessionId = "";
                }
            }
        })();
        return restorePromise;
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
        const latestCheckpoint = [...events].reverse().find(function (event) { return event.event_type === "checkpoint"; });
        const needsFollowupReplan = latestCheckpoint?.payload?.reason === "user followup pending";
        if (!calls.length && !needsFollowupReplan) return;
        const config = tools.assistantConfig();
        const run = {
            id: `q3vl-resume-${Date.now().toString(36)}`,
            sessionId: session.session_id,
            sessionRunId: session.active_run_id,
            controller: new AbortController(),
            cancelled: false,
            turnId: Math.max(0, ...events.map(function (event) { return Number(event.turn_id) || 0; })),
            resourceMutationAllowed: false
        };
        const lastUserMessage = [...events].reverse().find(function (event) { return event.event_type === "user_message"; });
        const requestText = String(lastUserMessage?.payload?.content || "");
        run.resourceMutationAllowed = Boolean(tools.assistantUserRequestedPromptEdit?.(requestText) || tools.assistantUserRequestedResourceMutation?.(requestText));
        const sendButton = tools.assistantPanel()?.querySelector("#q3vl_assistant_send");
        tools.assistantState.running = run;
        setSendRunning(sendButton, true);
        try {
            if (!calls.length) await resumeSessionRun(run);
            await continueSessionRun(run, config, calls);
        } catch (error) {
            tools.addAssistantMessage("error", String(error?.message || error));
        } finally {
            if (tools.assistantState.running === run) tools.assistantState.running = null;
            tools.assistantState.resourceMutationAllowed = false;
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
        const menu = document.createElement("div");
        menu.id = "q3vl_assistant_session_menu";
        menu.className = "q3vl-assistant-session-menu";
        menu.hidden = false;
        const search = document.createElement("input");
        search.type = "search";
        search.className = "q3vl-assistant-session-search";
        search.placeholder = "Search sessions";
        search.setAttribute("aria-label", "Search sessions");
        const results = document.createElement("div");
        results.className = "q3vl-assistant-session-results";
        menu.append(search, results);
        panel.querySelector(".q3vl-assistant-head")?.appendChild(menu);
        let requestId = 0;
        let timer = 0;
        const load = async function (query) {
            const current = ++requestId;
            results.textContent = "Searching...";
            try {
                const response = await sessionRequest(assistantSessionListPath(query));
                const data = await response.json();
                if (current !== requestId || !menu.isConnected) return;
                results.replaceChildren();
                (data.sessions || []).forEach(function (session) {
                    const item = document.createElement("button");
                    item.type = "button";
                    item.textContent = `${session.title || "New session"} · ${session.state}`;
                    item.setAttribute("aria-selected", String(session.session_id === activeSessionId()));
                    item.addEventListener("click", function () {
                        if (tools.assistantState.running) return;
                        setActiveSessionId(session.session_id);
                        panel.dataset.q3vlSessionRestored = "";
                        panel.querySelector("#q3vl_assistant_messages")?.replaceChildren();
                        menu.remove();
                        restoreAssistantSession();
                    });
                    results.appendChild(item);
                });
                if (!results.childElementCount) results.textContent = query ? "No matching sessions" : "No saved sessions";
            } catch (_error) {
                if (current === requestId) results.textContent = "Unable to load sessions";
            }
        };
        search.addEventListener("input", function () {
            window.clearTimeout(timer);
            timer = window.setTimeout(function () { load(search.value); }, 180);
        });
        await load("");
        search.focus();
    }

    Object.assign(tools, {
        ensureAssistantSession,
        runAssistantSessionLoop,
        queueAssistantFollowup,
        cancelAssistantSessionRun,
        restoreAssistantSession,
        resetAssistantSession,
        createAssistantSession,
        openAssistantSessionHistory,
        assistantSessionListPath
    });
})();
