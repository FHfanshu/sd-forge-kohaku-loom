(function () {
    var mounted = false;
    var uiLoadedRegistered = false;
    var forgeUiLoaded = false;
    var retryTimer = null;
    var attempts = 0;
    var MAX_ATTEMPTS = 200;

    function forgeUiIsPresent() {
        try {
            var root = typeof window.gradioApp === "function" ? window.gradioApp() : document;
            return Boolean(root && typeof root.querySelector === "function" && root.querySelector("#txt2img_prompt"));
        } catch (_) {
            return false;
        }
    }

    function showFatalError(message) {
        var existing = document.getElementById("prompt-agent-boot-error");
        if (existing) {
            existing.querySelector("span").textContent = message;
            return;
        }
        var panel = document.createElement("div");
        panel.id = "prompt-agent-boot-error";
        panel.style.cssText = ["position:fixed", "right:16px", "bottom:16px", "z-index:2147483647", "max-width:360px", "padding:12px 14px", "border:1px solid #dc2626", "border-radius:10px", "background:#18181b", "color:#fafafa", "font:13px/1.5 sans-serif"].join(";");
        var title = document.createElement("strong");
        title.textContent = "SD Forge Neo Prompt Agent failed to start";
        var text = document.createElement("span");
        text.style.display = "block";
        text.style.marginTop = "6px";
        text.textContent = message;
        var retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = "Retry";
        retry.style.marginTop = "8px";
        retry.onclick = function () {
            panel.remove();
            attempts = 0;
            schedule();
        };
        panel.append(title, text, retry);
        document.body.appendChild(panel);
    }

    function mountUi() {
        if (mounted) return true;
        if (!forgeUiLoaded && forgeUiIsPresent()) forgeUiLoaded = true;
        if (!forgeUiLoaded) return false;
        var namespace = window.__SD_FORGE_NEO_PROMPT_AGENT__;
        var ui = namespace && namespace.ui;
        if (!ui || ui.UI_READY !== true || typeof ui.mountSvelteUi !== "function") return false;
        try {
            ui.mountSvelteUi();
            mounted = true;
            document.getElementById("prompt-agent-boot-error")?.remove();
            return true;
        } catch (error) {
            showFatalError(error instanceof Error ? error.message : String(error));
            return false;
        }
    }

    function attemptBoot() {
        retryTimer = null;
        registerUiLoaded();
        if (mountUi()) return;
        attempts += 1;
        if (attempts >= MAX_ATTEMPTS) {
            showFatalError("Svelte UI bundle or Forge UI lifecycle was unavailable.");
            return;
        }
        schedule();
    }

    function schedule() {
        if (retryTimer !== null || mounted) return;
        retryTimer = window.setTimeout(attemptBoot, 100);
    }

    function registerUiLoaded() {
        if (uiLoadedRegistered || typeof window.onUiLoaded !== "function") return;
        uiLoadedRegistered = true;
        window.onUiLoaded(function () {
            forgeUiLoaded = true;
            if (!mountUi()) schedule();
        });
    }

    window.addEventListener("prompt-agent:svelte-ready", function () {
        registerUiLoaded();
        if (!mountUi()) schedule();
    });
    registerUiLoaded();
    if (!mountUi()) schedule();
})();
