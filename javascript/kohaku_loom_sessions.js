(function () {
    const tools = window.kohakuLoom;
    if (!tools) return;

    const BASE = "/kohaku-loom/kt";
    const SESSION_KEY = "loom_kt_active_session";
    const RUNTIME_KEY = "loom_assistant_runtime";
    const PROFILE_IMPORT_KEY = "loom_kt_profiles_imported_v1";
    const SESSION_PROFILE_KEY = "loom_kt_session_profile_snapshot";
    const REWIND_KEY_PREFIX = "loom_kt_rewind_v1_";
    let restorePromise = null;
    let sessionGeneration = 0;
    tools.assistantState.durableSessions = true;

    function assistantRuntime() {
        return localStorage.getItem(RUNTIME_KEY) || "kohaku-terrarium";
    }

    function setAssistantRuntime(runtime) {
        const value = String(runtime || "");
        if (value !== "kohaku-terrarium") throw new Error(`Unsupported assistant runtime: ${value}`);
        localStorage.setItem(RUNTIME_KEY, value);
        return value;
    }

    function activeSessionId() {
        return localStorage.getItem(SESSION_KEY) || "";
    }

    function setActiveSessionId(sessionId) {
        if (sessionId) localStorage.setItem(SESSION_KEY, sessionId);
        else localStorage.removeItem(SESSION_KEY);
        tools.assistantState.sessionId = sessionId || "";
        sessionGeneration += 1;
    }

    function rewindStorageKey(sessionId) {
        return REWIND_KEY_PREFIX + String(sessionId || "");
    }

    function rewindSnapshots(sessionId) {
        try {
            const saved = JSON.parse(localStorage.getItem(rewindStorageKey(sessionId)) || "{}");
            return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
        } catch (_error) {
            return {};
        }
    }

    function storeRewindSnapshot(sessionId, userIndex, snapshot) {
        if (!sessionId || !snapshot || !Array.isArray(snapshot.controls)) return;
        const snapshots = rewindSnapshots(sessionId);
        snapshots[String(userIndex)] = snapshot;
        localStorage.setItem(rewindStorageKey(sessionId), JSON.stringify(snapshots));
    }

    function rewindSnapshot(sessionId, userIndex) {
        return rewindSnapshots(sessionId)[String(userIndex)] || null;
    }

    async function ktRequest(path, options) {
        const response = await fetch(BASE + path, options);
        if (!response.ok) {
            let detail = await response.text();
            try { detail = JSON.parse(detail).detail || detail; } catch (_error) { }
            throw new Error(String(detail || `HTTP ${response.status}`));
        }
        return response.status === 204 ? null : response;
    }

    async function ktJson(path, options) {
        const response = await ktRequest(path, options);
        return response ? response.json() : null;
    }

    async function forgeJson(path, options) {
        const response = await fetch(`/kohaku-loom${path}`, options);
        if (!response.ok) throw new Error(await response.text());
        return await response.json();
    }

    async function importAssistantProfiles(force, invalidateSession) {
        if (!tools.profileStore) throw new Error("Model Profile store is unavailable");
        if (!force && localStorage.getItem(PROFILE_IMPORT_KEY) === "1") return;
        const imported = await ktJson("/profiles/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(tools.profileStore.load())
        });
        if (tools.LEGACY_PROFILE_STORAGE_KEY) localStorage.removeItem(tools.LEGACY_PROFILE_STORAGE_KEY);
        (tools.LEGACY_ASSISTANT_PROFILE_KEYS || []).filter(function (key) { return String(key).startsWith("q3vl_assistant_"); }).forEach(function (key) {
            localStorage.removeItem(key);
        });
        tools.profileStore.scrubApiKeys();
        if (invalidateSession) localStorage.removeItem(SESSION_PROFILE_KEY);
        localStorage.setItem(PROFILE_IMPORT_KEY, "1");
        return imported;
    }

    async function profileChat(profileId, messages, signal) {
        await importAssistantProfiles(true, false);
        return await ktJson(`/profiles/${encodeURIComponent(profileId)}/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: signal,
            body: JSON.stringify({ messages: messages })
        });
    }

    function assistantSessionListPath() {
        return "/sessions";
    }

    async function closeActiveSession() {
        const runtime = await ktJson("/runtime");
        if (runtime?.active_session) {
            if (runtime.active_turn_id) throw new Error("Cannot switch sessions while a turn is active");
            await ktJson("/sessions/close", { method: "POST" });
        }
    }

    async function openSession(profileId, sessionId, resume) {
        await importAssistantProfiles(true, false);
        const data = await ktJson("/sessions/open", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                profile_id: profileId,
                session_id: sessionId || "",
                resume: Boolean(resume),
                forge_bridge: true
            })
        });
        setActiveSessionId(data.session.session_id);
        localStorage.setItem(SESSION_PROFILE_KEY, profileSnapshot(profileId));
        return data.session;
    }

    function profileSnapshot(profileId) {
        return JSON.stringify(tools.profileStore.requestProjection(profileId));
    }

    async function ensureAssistantSession(config) {
        setAssistantRuntime(assistantRuntime());
        await importAssistantProfiles(false, false);
        const runtime = await ktJson("/runtime");
        const storedId = activeSessionId();
        if (runtime.active_session) {
            const profileChanged = localStorage.getItem(SESSION_PROFILE_KEY) !== profileSnapshot(config.profile_id);
            if (runtime.active_session.profile_id !== config.profile_id || profileChanged) {
                const sessionId = runtime.active_session.session_id;
                await closeActiveSession();
                return (await openSession(config.profile_id, sessionId, true)).session_id;
            }
            setActiveSessionId(runtime.active_session.session_id);
            return runtime.active_session.session_id;
        }
        if (storedId) {
            try {
                return (await openSession(config.profile_id, storedId, true)).session_id;
            } catch (_error) {
                setActiveSessionId("");
            }
        }
        return (await openSession(config.profile_id, "", false)).session_id;
    }

    function setSendRunning(button, running) {
        if (!button) return;
        button.hidden = Boolean(running);
        const stop = tools.assistantPanel()?.querySelector("#loom_assistant_stop");
        if (stop) {
            stop.hidden = !running;
            stop.disabled = !running;
        }
        tools.assistantPanel()?.querySelectorAll(".loom-assistant-runtime-control").forEach(function (control) {
            control.disabled = Boolean(running);
        });
    }

    function assertRunning(run) {
        if (!run || run.cancelled || run.controller.signal.aborted) throw new Error("assistant run aborted");
    }

    function sseFrames(buffer) {
        const frames = [];
        let rest = buffer;
        let boundary;
        while ((boundary = rest.search(/\r?\n\r?\n/)) >= 0) {
            const marker = rest.match(/\r?\n\r?\n/);
            frames.push(rest.slice(0, boundary));
            rest = rest.slice(boundary + marker[0].length);
        }
        return { frames: frames, rest: rest };
    }

    function parseSseFrame(frame) {
        if (!frame || frame.startsWith(":")) return null;
        let id = 0;
        let type = "message";
        const data = [];
        frame.split(/\r?\n/).forEach(function (line) {
            if (line.startsWith("id:")) id = Number(line.slice(3).trim()) || 0;
            else if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        });
        if (!data.length) return null;
        const event = JSON.parse(data.join("\n"));
        if (!event.sequence && id) event.sequence = id;
        if (!event.type) event.type = type;
        return event;
    }

    async function consumeSse(path, run, cursorName, onEvent) {
        let delay = 100;
        while (!run.finished && !run.controller.signal.aborted) {
            try {
                const cursor = Number(run[cursorName]) || 0;
                const response = await ktRequest(`${path}?after=${cursor}`, {
                    headers: { "Last-Event-ID": String(cursor) },
                    signal: run.streamController.signal
                });
                if (!response.body) throw new Error("SSE response body is unavailable");
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                while (!run.finished) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    buffer += decoder.decode(chunk.value, { stream: true });
                    const parsed = sseFrames(buffer);
                    buffer = parsed.rest;
                    for (const frame of parsed.frames) {
                        const event = parseSseFrame(frame);
                        if (!event) continue;
                        await onEvent(event);
                        run[cursorName] = Math.max(Number(run[cursorName]) || 0, Number(event.sequence) || 0);
                    }
                }
                delay = 100;
            } catch (error) {
                if (run.finished || run.streamController.signal.aborted) return;
                await new Promise(function (resolve) { window.setTimeout(resolve, delay); });
                delay = Math.min(delay * 2, 2000);
            }
        }
    }

    function unpackForgeArguments(args) {
        const source = args && typeof args === "object" ? Object.assign({}, args) : {};
        if (typeof source.content !== "string") return source;
        try {
            const parsed = JSON.parse(source.content);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return source;
            delete source.content;
            return Object.assign(source, parsed);
        } catch (_error) {
            return source;
        }
    }

    function adaptForgeTool(tool, rawArgs) {
        const args = unpackForgeArguments(rawArgs);
        if (tool === "initialize_prompt") {
            return {
                tool: tool,
                arguments: Object.assign({}, args, {
                    positive_prompt: args.positive_prompt === undefined ? args.positive : args.positive_prompt,
                    negative_prompt: args.negative_prompt === undefined ? args.negative : args.negative_prompt
                })
            };
        }
        if (tool === "edit_prompt") {
            const field = args.field === "negative" ? "negative" : "positive";
            const promptKey = field === "negative" ? "negative_prompt" : "positive_prompt";
            const hashKey = field === "negative" ? "negative_prompt_hash" : "positive_prompt_hash";
            return {
                tool: tool,
                arguments: Object.assign({}, args, {
                    field: field,
                    prompt: args.prompt === undefined ? args[promptKey] : args.prompt,
                    base_hash: args.base_hash || args[hashKey] || args.prompt_hash
                })
            };
        }
        if (tool !== "forge_resource") return { tool: tool, arguments: args };
        const action = String(args.action || "");
        if (action === "search") return { tool: "search_resources", arguments: args };
        if (action === "inspect") return { tool: "inspect_resource", arguments: Object.assign({}, args, { id: args.resource_id }) };
        if (action === "apply") return { tool: "apply_resource", arguments: Object.assign({}, args, { id: args.resource_id }) };
        return { tool: tool, arguments: args };
    }

    function ktMutationTool(name, args) {
        if (["edit_prompt", "initialize_prompt"].includes(name)) return true;
        return name === "forge_resource" && String(args?.action || "") === "apply";
    }

    async function replyToTool(requestId, result) {
        try {
            await ktJson(`/tools/replies/${encodeURIComponent(requestId)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(result)
            });
        } catch (error) {
            if (!/unknown tool request|already completed/i.test(String(error.message || error))) throw error;
        }
    }

    async function handleToolEvent(run, event) {
        if (event.type !== "tool_request") return;
        const payload = event.payload || {};
        if (!payload.request_id || run.toolRequests.has(payload.request_id)) return;
        const call = adaptForgeTool(payload.tool, payload.arguments || {});
        let result = run.toolResults.get(payload.request_id);
        if (!result) {
            try {
                assertRunning(run);
                result = await tools.executeAssistantTool(call, run.controller.signal);
            } catch (error) {
                result = { ok: false, error: String(error?.message || error) };
            }
            run.toolResults.set(payload.request_id, result);
            const label = tools.assistantToolResultLabel?.(call.tool, result) || `工具 ${call.tool}: ${result.ok ? "完成" : "失败"}`;
            tools.addAssistantMessage("tool", label);
        }
        await replyToTool(payload.request_id, result);
        run.toolRequests.add(payload.request_id);
        run.toolResults.delete(payload.request_id);
    }

    function handleTurnEvent(run, event) {
        const payload = event.payload || {};
        if (run.turnId && payload.turn_id && payload.turn_id !== run.turnId) return;
        if (event.type === "text_delta") {
            run.text += String(payload.text || "");
            if (!run.streamItem) run.streamItem = tools.addAssistantMessage("assistant", "");
            tools.updateAssistantStreamingMessage(run.streamItem, run.text, run.reasoning, tools.renderAssistantMarkdown);
            return;
        }
        if (event.type === "reasoning_delta" || event.type === "reasoning_snapshot") {
            const reasoning = String(payload.text || "");
            run.reasoning = event.type === "reasoning_snapshot" ? reasoning : run.reasoning + reasoning;
            if (!run.streamItem) run.streamItem = tools.addAssistantMessage("assistant", "");
            tools.updateAssistantStreamingMessage(run.streamItem, run.text, run.reasoning, tools.renderAssistantMarkdown);
            return;
        }
        if (event.type === "usage") {
            run.usage = payload.usage || payload;
            if (run.statusItem) tools.updateAssistantMessage(run.statusItem, "status", tools.formatAssistantTokenStatus(run.usage));
            return;
        }
        if (event.type !== "turn_ended") return;
        run.result = payload;
        if (!run.streamItem && payload.text) run.streamItem = tools.addAssistantMessage("assistant", payload.text);
        else if (run.streamItem && payload.text && payload.text !== run.text) {
            run.text = payload.text;
            tools.updateAssistantStreamingMessage(run.streamItem, run.text, run.reasoning, tools.renderAssistantMarkdown);
        }
        run.finished = true;
        run.streamController.abort();
        run.resolve(payload);
    }

    function attachmentContent(text, attachments) {
        const parts = [];
        if (text) parts.push({ type: "text", text: text });
        attachments.forEach(function (item) {
            parts.push({
                type: "image_url",
                image_url: { url: item.dataUrl, detail: "high" },
                meta: { source_type: "attachment", source_name: item.name || "reference image" }
            });
        });
        return parts;
    }

    function attachmentAnalysisProfile(config) {
        const state = tools.profileStore.load();
        if (tools.assistantUsesGeminiVisionDelegate?.(config)) {
            const teacher = state.profiles.find(function (profile) { return profile.id === state.teacher_profile_id; });
            if (teacher?.enabled && teacher.capabilities?.vision) return teacher;
        }
        const local = state.profiles.find(function (profile) { return profile.id === state.session_profile_id; });
        if (local?.enabled && local.capabilities?.vision) return local;
        return state.profiles.find(function (profile) { return profile.enabled && profile.capabilities?.vision; }) || null;
    }

    async function summarizeAttachments(text, attachments, config, run) {
        if (!attachments.length || tools.assistantSupportsNativeImages?.(config)) {
            return attachments.length ? attachmentContent(text, attachments) : text;
        }
        const profile = attachmentAnalysisProfile(config);
        if (!profile) throw new Error("No enabled vision Profile is available for attachment analysis");
        const summaries = [];
        for (const [index, attachment] of attachments.entries()) {
            assertRunning(run);
            const prompt = `Analyze reference image ${index + 1} for a downstream prompt assistant. Return a concise factual briefing covering subject count, composition, spatial relationships, clothing, objects, setting, lighting, camera, and reusable style. Do not use markdown or call tools.${text ? `\nUser task context: ${text.slice(0, 800)}` : ""}`;
            const result = await profileChat(profile.id, attachmentContent(prompt, [attachment]), run.controller.signal);
            const summary = String(result.text || "").trim();
            if (!summary) throw new Error(`Vision Profile ${profile.display_name || profile.id} returned an empty briefing`);
            summaries.push(`Reference image ${index + 1} (${attachment.name || "image"}):\n${summary}`);
            tools.addAssistantMessage("tool", `视觉摘要 (${profile.display_name || result.model || profile.id}):\n${tools.truncateAssistantText(summary, 1200)}`);
        }
        return `${text}\n\n${summaries.join("\n\n")}`.trim();
    }

    function legacyTranscript(data) {
        const rows = [];
        if (data.session?.summary) rows.push(`Earlier summary: ${data.session.summary}`);
        (data.events || []).forEach(function (event) {
            const payload = event.payload || {};
            const message = payload.message || payload;
            const content = String(message.content || "").trim();
            if (!content) return;
            if (event.event_type === "user_message" || event.event_type === "user_followup_queued") rows.push(`User: ${content}`);
            else if (event.event_type === "assistant_message" && !message.tool_calls?.length) rows.push(`Assistant: ${content}`);
        });
        const transcript = rows.join("\n\n");
        return transcript.length > 48000 ? transcript.slice(-48000) : transcript;
    }

    function renderLegacySession(data) {
        const panel = tools.assistantPanel?.();
        const log = panel?.querySelector("#loom_assistant_messages");
        if (!log) return;
        log.replaceChildren();
        tools.addAssistantMessage("tool", "旧会话只读预览。发送下一条消息时会创建新的 KT 会话并携带此上下文。");
        (data.events || []).forEach(function (event) {
            const payload = event.payload || {};
            const message = payload.message || payload;
            if (event.event_type === "user_message" || event.event_type === "user_followup_queued") {
                tools.addAssistantUserMessage(message.content || "", message.image ? [{ dataUrl: message.image, name: message.filename || "reference image" }] : [], message.content || "");
            } else if (event.event_type === "assistant_message" && !message.tool_calls?.length) {
                tools.addAssistantMessage("assistant", message.content || "");
            }
        });
        tools.assistantState.legacyContext = legacyTranscript(data);
        if (panel) panel.dataset.loomSessionRestored = "legacy";
    }

    async function runAssistantSessionLoop(userText, attachment, displayText) {
        const state = tools.assistantState;
        if (state.running) return queueAssistantFollowup(userText, attachment, displayText);
        const attachments = tools.normalizedAssistantAttachments?.(attachment) || (attachment ? [attachment] : []);
        const text = String(userText || (attachments.length ? "请根据附件例图分析构图和风格，帮助我整理提示词。" : "")).trim();
        if (!text && !attachments.length) return;
        const config = tools.assistantConfig();
        const run = {
            controller: new AbortController(),
            streamController: new AbortController(),
            cancelled: false,
            finished: false,
            turnCursor: 0,
            toolCursor: 0,
            toolRequests: new Set(),
            toolResults: new Map(),
            turnId: "",
            text: "",
            reasoning: "",
            usage: null,
            streamItem: null
        };
        run.done = new Promise(function (resolve, reject) { run.resolve = resolve; run.reject = reject; });
        const sendButton = tools.assistantPanel()?.querySelector("#loom_assistant_send");
        let status = null;
        state.running = run;
        setSendRunning(sendButton, true);
        try {
            await ensureAssistantSession(config);
            const sessionId = activeSessionId();
            const conversation = await ktJson(`/sessions/${encodeURIComponent(sessionId)}`);
            const userIndex = (conversation.messages || []).filter(function (message) { return message.role === "user"; }).length;
            const forgeSnapshot = tools.captureForgeUiState?.();
            storeRewindSnapshot(sessionId, userIndex, forgeSnapshot);
            tools.addAssistantUserMessage(displayText === undefined ? text : displayText, attachments, text, forgeSnapshot);
            let content = await summarizeAttachments(text, attachments, config, run);
            if (state.legacyContext) {
                const imported = `Read-only conversation imported from the legacy Loom runtime:\n\n${state.legacyContext}\n\nCurrent user request:\n`;
                if (Array.isArray(content)) content = [{ type: "text", text: imported }, ...content];
                else content = imported + content;
                state.legacyContext = "";
            }
            const runtime = await ktJson("/runtime");
            run.turnCursor = Number(runtime.turn_event_sequence) || 0;
            run.toolCursor = Number(runtime.tool_event_sequence) || 0;
            status = tools.addAssistantMessage("status", "思考中...");
            run.statusItem = status;
            const turnEvents = consumeSse("/turns/events", run, "turnCursor", function (event) { return handleTurnEvent(run, event); });
            const toolEvents = consumeSse("/tools/events", run, "toolCursor", function (event) { return handleToolEvent(run, event); });
            const accepted = await ktJson("/turns", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    content: content,
                    timeout: config.timeout || config.parameters?.timeout || 120
                })
            });
            run.turnId = accepted.turn_id;
            const result = await run.done;
            status?.remove();
            status = null;
            if (!["ok", "completed"].includes(String(result.status || "").toLowerCase()) && !run.cancelled) {
                throw new Error(result.error || `KohakuTerrarium turn ended with status ${result.status}`);
            }
            await Promise.allSettled([turnEvents, toolEvents]);
        } catch (error) {
            status?.remove();
            const message = String(error?.message || error);
            if (run.cancelled || run.controller.signal.aborted || message === "assistant run aborted") tools.addAssistantMessage("status", "已终止。");
            else tools.addAssistantMessage("error", message);
        } finally {
            run.finished = true;
            run.streamController.abort();
            run.controller.abort();
            if (state.running === run) state.running = null;
            setSendRunning(sendButton, false);
        }
    }

    function queueAssistantFollowup(userText, attachment, displayText) {
        if (!tools.assistantState.running) return Promise.reject(new Error("当前没有可跟进的 Agent 运行。"));
        const attachments = tools.normalizedAssistantAttachments?.(attachment) || (attachment ? [attachment] : []);
        const text = String(userText || "").trim();
        if (!text && !attachments.length) return Promise.resolve();
        tools.addAssistantMessage("error", "当前 turn 正在运行；请等待完成或先终止。");
        return Promise.resolve();
    }

    function cancelAssistantSessionRun() {
        const run = tools.assistantState.running;
        if (!run || run.cancelled) return;
        run.cancelled = true;
        if (run.turnId) fetch(`${BASE}/turns/${encodeURIComponent(run.turnId)}/cancel`, { method: "POST" }).catch(function () { });
    }

    function messageText(content) {
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return "";
        return content.filter(function (part) { return part && part.type === "text"; }).map(function (part) { return part.text || ""; }).join("\n");
    }

    function messageAttachments(content) {
        if (!Array.isArray(content)) return [];
        return content.filter(function (part) { return part && part.type === "image_url" && part.image_url?.url; }).map(function (part) {
            return { dataUrl: part.image_url.url, name: part.meta?.source_name || "reference image" };
        });
    }

    function renderConversationMessage(message, userIndex, sessionId) {
        const role = String(message.role || "");
        if (role === "system" || role === "tool") return;
        const text = messageText(message.content);
        if (role === "user") tools.addAssistantUserMessage(text, messageAttachments(message.content), text, rewindSnapshot(sessionId, userIndex));
        else if (role === "assistant" && text) tools.addAssistantMessage("assistant", text);
    }

    async function restoreAssistantSession() {
        const panel = tools.assistantPanel?.();
        const sessionId = activeSessionId();
        if (!panel || !sessionId || panel.dataset.loomSessionRestored === sessionId) return;
        if (restorePromise) return restorePromise;
        const generation = sessionGeneration;
        restorePromise = (async function () {
            try {
                const config = tools.assistantConfig();
                const runtime = await ktJson("/runtime");
                if (!runtime.active_session) await openSession(config.profile_id, sessionId, true);
                else if (runtime.active_session.session_id !== sessionId) {
                    await closeActiveSession();
                    await openSession(config.profile_id, sessionId, true);
                }
                const data = await ktJson(`/sessions/${encodeURIComponent(sessionId)}`);
                if (generation !== sessionGeneration || activeSessionId() !== sessionId) return;
                const log = panel.querySelector("#loom_assistant_messages");
                if (!log) return;
                log.replaceChildren();
                let userIndex = 0;
                (data.messages || []).forEach(function (message) {
                    const isUser = message.role === "user";
                    renderConversationMessage(message, userIndex, sessionId);
                    if (isUser) userIndex += 1;
                });
                panel.dataset.loomSessionRestored = sessionId;
            } catch (_error) {
                if (generation === sessionGeneration) setActiveSessionId("");
            } finally {
                restorePromise = null;
            }
        })();
        return restorePromise;
    }

    async function resetAssistantSession() {
        setActiveSessionId("");
        tools.assistantState.legacyContext = "";
        localStorage.removeItem(SESSION_PROFILE_KEY);
        await closeActiveSession().catch(function () { });
    }

    async function createAssistantSession() {
        if (tools.assistantState.running) return;
        const config = tools.assistantConfig();
        await closeActiveSession();
        const session = await openSession(config.profile_id, "", false);
        const panel = tools.assistantPanel?.();
        panel?.querySelector("#loom_assistant_messages")?.replaceChildren();
        if (panel) panel.dataset.loomSessionRestored = session.session_id;
    }

    async function openAssistantSessionHistory() {
        const panel = tools.assistantPanel?.();
        if (!panel) return;
        panel.querySelector("#loom_assistant_session_menu")?.remove();
        const menu = document.createElement("div");
        menu.id = "loom_assistant_session_menu";
        menu.className = "loom-assistant-session-menu";
        const results = document.createElement("div");
        results.className = "loom-assistant-session-results";
        results.textContent = "Loading...";
        menu.appendChild(results);
        panel.querySelector(".loom-assistant-head")?.appendChild(menu);
        try {
            const [data, legacy] = await Promise.all([
                ktJson(assistantSessionListPath()),
                forgeJson("/legacy-sessions?limit=30").catch(function () { return { sessions: [] }; })
            ]);
            results.replaceChildren();
            (data.sessions || []).forEach(function (session) {
                const item = document.createElement("button");
                item.type = "button";
                const modified = session.modified_at ? new Date(session.modified_at * 1000).toLocaleString() : "";
                item.textContent = `${session.session_id}${modified ? ` · ${modified}` : ""}`;
                item.setAttribute("aria-selected", String(session.session_id === activeSessionId()));
                item.addEventListener("click", async function () {
                    if (tools.assistantState.running) return;
                    await closeActiveSession();
                    setActiveSessionId(session.session_id);
                    panel.dataset.loomSessionRestored = "";
                    panel.querySelector("#loom_assistant_messages")?.replaceChildren();
                    menu.remove();
                    await restoreAssistantSession();
                });
                results.appendChild(item);
            });
            (legacy.sessions || []).forEach(function (session) {
                const item = document.createElement("button");
                item.type = "button";
                item.textContent = `旧 · ${session.title || session.session_id}`;
                item.addEventListener("click", async function () {
                    if (tools.assistantState.running) return;
                    await closeActiveSession();
                    setActiveSessionId("");
                    const data = await forgeJson(`/legacy-sessions/${encodeURIComponent(session.session_id)}`);
                    menu.remove();
                    renderLegacySession(data);
                });
                results.appendChild(item);
            });
            if (!results.childElementCount) results.textContent = "No saved sessions";
        } catch (_error) {
            results.textContent = "Unable to load sessions";
        }
    }

    Object.assign(tools, {
        KT_ASSISTANT_BASE: BASE,
        assistantRuntime,
        setAssistantRuntime,
        importAssistantProfiles,
        profileChat,
        ensureAssistantSession,
        runAssistantSessionLoop,
        queueAssistantFollowup,
        cancelAssistantSessionRun,
        restoreAssistantSession,
        resetAssistantSession,
        createAssistantSession,
        openAssistantSessionHistory,
        assistantSessionListPath,
        rewindSnapshots,
        rewindSnapshot,
        storeRewindSnapshot,
        parseKtSseFrame: parseSseFrame,
        adaptKtForgeTool: adaptForgeTool,
        ktMutationTool,
        setAssistantRunning: setSendRunning,
        handleKtTurnEvent: handleTurnEvent,
        handleKtToolEvent: handleToolEvent
    });
})();
