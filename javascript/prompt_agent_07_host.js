(function () {
    const tools = window.__SD_FORGE_NEO_PROMPT_AGENT__;
    if (!tools) return;
    window.__SD_FORGE_NEO_PROMPT_AGENT__ = tools;

    const HOST_API_NAME = "prompt-agent-host";
    const BRIDGE_NAME = "prompt-agent-ui";
    const API_VERSION = 1;
    const VERSION = "1.0.0";
    const CAPABILITIES = Object.freeze([
        "forge-availability", "prompt-target", "forge-state", "tool-execution",
        "locale-hints"
    ]);

    function bridgeResponse(request) {
        if (request?.client !== BRIDGE_NAME) return { ok: false, bridge: BRIDGE_NAME, apiVersion: API_VERSION, reason: "client-mismatch" };
        if (Number(request?.apiVersion) !== API_VERSION) return { ok: false, bridge: BRIDGE_NAME, apiVersion: API_VERSION, reason: "unsupported-api-version" };
        return { ok: true, bridge: BRIDGE_NAME, apiVersion: API_VERSION, version: VERSION, capabilities: CAPABILITIES };
    }

    function localeHints() {
        if (typeof tools.getLocaleHints === "function") return tools.getLocaleHints();
        return { locale: tools.forgeLocale || tools.activeLocale || "en", supported_locales: ["en", "zh-CN"], source: "forge-metadata" };
    }

    function subscribeLocaleHints(listener) {
        if (typeof listener !== "function" || typeof window.addEventListener !== "function") return function () { };
        const names = ["prompt-agent:locale-hints-changed", "prompt-agent:locale-changed", "prompt-agent:forge-locale-changed"];
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
        isForgeAvailable: function () { return typeof tools.promptAgentMainApp === "function" && Boolean(tools.promptAgentMainApp()); },
        activePromptTarget: function () { return tools.activePromptTarget(); },
        readPrompt: function (target) { return tools.readPromptTool(target || "active"); },
        captureForgeState: function () { return tools.captureForgeUiState(); },
        restoreForgeState: function (snapshot) { return tools.restoreForgeUiState(snapshot); },
        executeTool: function (tool, signal) { return tools.executeAssistantTool(tool, signal); },
        executeAssistantTool: function (tool, signal) { return tools.executeAssistantTool(tool, signal); },
        openSettings: function () {
            const ui = tools.ui;
            if (!ui || typeof ui.openProfileSettings !== "function") throw new Error("Profile settings are unavailable");
            return ui.openProfileSettings();
        },
        getLocaleHints: localeHints,
        subscribeLocaleHints: subscribeLocaleHints
    });

    if (!tools.hostApi || tools.hostApi.name !== HOST_API_NAME || tools.hostApi.apiVersion !== API_VERSION) tools.hostApi = hostApi;
})();
