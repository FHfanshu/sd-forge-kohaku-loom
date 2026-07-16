(function () {
    const tools = window.kohakuLoom;
    if (!tools) return;

    const HOST_API_NAME = "kohaku-loom-host";
    const BRIDGE_NAME = "kohaku-loom-svelte-ui";
    const API_VERSION = 1;
    const VERSION = "1.0.0";
    const KT_BASE = "/kohaku-loom/kt";
    const CAPABILITIES = Object.freeze([
        "forge-availability", "prompt-target", "forge-state", "tool-execution",
        "profile-store", "tool-bridge-lease", "assistant-config", "session-runtime",
        "legacy-sessions", "locale-hints"
    ]);

    function bridgeResponse(request) {
        if (request?.client !== BRIDGE_NAME) return { ok: false, bridge: BRIDGE_NAME, apiVersion: API_VERSION, reason: "client-mismatch" };
        if (Number(request?.apiVersion) !== API_VERSION) return { ok: false, bridge: BRIDGE_NAME, apiVersion: API_VERSION, reason: "unsupported-api-version" };
        return { ok: true, bridge: BRIDGE_NAME, apiVersion: API_VERSION, version: VERSION, capabilities: CAPABILITIES };
    }

    function profileMethod(name) {
        return function () {
            const store = tools.profileStore;
            if (!store || typeof store[name] !== "function") throw new Error(`Profile store method is unavailable: ${name}`);
            return store[name].apply(store, arguments);
        };
    }

    const profileStore = {};
    ["load", "current", "teacher", "session", "add", "duplicate", "update", "delete", "setActive", "setTeacher", "setSession", "setNaming", "restoreDefaults", "requestProjection"].forEach(function (name) {
        profileStore[name] = profileMethod(name);
    });

    function localeHints() {
        if (typeof tools.getLocaleHints === "function") return tools.getLocaleHints();
        return { locale: tools.forgeLocale || tools.loomForgeLocale || tools.loomActiveLocale || "en", supported_locales: ["en", "zh-CN"], source: "forge-metadata" };
    }

    function ktBaseUrl() {
        return String(tools.KT_ASSISTANT_BASE || KT_BASE);
    }

    async function ktJson(path, options) {
        const response = await fetch(ktBaseUrl() + path, options);
        if (!response.ok) {
            let detail = await response.text();
            try { detail = JSON.parse(detail).detail || detail; } catch (_error) { }
            throw new Error(String(detail || `HTTP ${response.status}`));
        }
        return response.status === 204 ? null : response.json();
    }

    async function syncProfiles() {
        if (!tools.profileStore) throw new Error("Model Profile store is unavailable");
        const imported = await ktJson("/profiles/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(tools.profileStore.load())
        });
        if (tools.LEGACY_PROFILE_STORAGE_KEY) localStorage.removeItem(tools.LEGACY_PROFILE_STORAGE_KEY);
        (tools.LEGACY_ASSISTANT_PROFILE_KEYS || []).filter(function (key) {
            return String(key).startsWith("q3vl_assistant_");
        }).forEach(function (key) { localStorage.removeItem(key); });
        if (typeof tools.profileStore.scrubApiKeys === "function") tools.profileStore.scrubApiKeys();
        return imported;
    }

    async function profileChat(profileId, messages, signal) {
        await syncProfiles();
        return ktJson(`/profiles/${encodeURIComponent(profileId)}/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: signal,
            body: JSON.stringify({ messages: messages })
        });
    }

    function listLegacySessions(limit) {
        return fetch(`/kohaku-loom/legacy-sessions?limit=${encodeURIComponent(limit || 50)}`).then(function (response) {
            if (!response.ok) throw new Error(`Legacy session list failed: HTTP ${response.status}`);
            return response.json();
        });
    }

    function getLegacySession(sessionId, limit) {
        return fetch(`/kohaku-loom/legacy-sessions/${encodeURIComponent(sessionId)}?limit=${encodeURIComponent(limit || 500)}`).then(function (response) {
            if (!response.ok) throw new Error(`Legacy session load failed: HTTP ${response.status}`);
            return response.json();
        });
    }

    function subscribeLocaleHints(listener) {
        if (typeof listener !== "function" || typeof window.addEventListener !== "function") return function () { };
        const names = ["kohaku-loom:locale-hints-changed", "kohaku-loom:locale-changed", "forge-locale-changed"];
        const handler = function () { listener(localeHints()); };
        names.forEach(function (name) { window.addEventListener(name, handler); });
        return function () { names.forEach(function (name) { window.removeEventListener(name, handler); }); };
    }

    const hostApi = Object.freeze({
        name: HOST_API_NAME,
        version: VERSION,
        apiVersion: API_VERSION,
        capabilities: CAPABILITIES,
        handshake: bridgeResponse,
        isForgeAvailable: function () { return typeof tools.loomMainApp === "function" && Boolean(tools.loomMainApp()); },
        activePromptTarget: function () { return tools.activePromptTarget(); },
        readPrompt: function (target) { return tools.readPromptTool(target || "active"); },
        captureForgeState: function () { return tools.captureForgeUiState(); },
        restoreForgeState: function (snapshot) { return tools.restoreForgeUiState(snapshot); },
        executeTool: function (tool, signal) { return tools.executeAssistantTool(tool, signal); },
        executeAssistantTool: function (tool, signal) { return tools.executeAssistantTool(tool, signal); },
        assistantConfig: function (routeOverride) {
            if (typeof tools.assistantConfig !== "function") throw new Error("Assistant config is unavailable");
            return tools.assistantConfig(routeOverride);
        },
        profileStore: Object.freeze(profileStore),
        claimToolBridge: function () { return tools.claimAssistantToolBridge(); },
        claimAssistantToolBridge: function () { return tools.claimAssistantToolBridge(); },
        syncProfiles: syncProfiles,
        profileChat: profileChat,
        listLegacySessions: listLegacySessions,
        getLegacySession: getLegacySession,
        ktBaseUrl: ktBaseUrl(),
        openSettings: function () {
            const ui = window.KohakuLoomSvelteUi;
            if (!ui || typeof ui.openProfileSettings !== "function") throw new Error("Profile settings are unavailable");
            return ui.openProfileSettings();
        },
        getLocaleHints: localeHints,
        subscribeLocaleHints: subscribeLocaleHints
    });

    tools.profileChat = profileChat;
    if (!tools.hostApi || tools.hostApi.name !== HOST_API_NAME || tools.hostApi.apiVersion !== API_VERSION) tools.hostApi = hostApi;
})();
