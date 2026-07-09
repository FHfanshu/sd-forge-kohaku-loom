(function () {
    const tools = window.q3vlPromptTools;
    if (!tools) return;
    const {
        q3vlApp,
        q3vlMainApp,
        removeAssistantWindow,
        setupQwenPresetGate,
        setupSendButtons,
        assistantState,
        DEEPSEEK_ASSISTANT_ENDPOINT,
        KNOWN_ASSISTANT_MODELS,
        MOYUU_ASSISTANT_FALLBACK_ENDPOINT,
        q3vlVisionPresets,
        storedAssistantEndpoint,
        storedAssistantModel,
        loadAssistantApiKey,
        normalizeAssistantMaxTokens,
        defaultVisionPreset,
        visionModelForPreset,
        setAssistantSettingsVisibility,
        syncAssistantBackendDefaults,
        saveAssistantConfig,
        runAssistantLoop,
        setAssistantAttachment,
        renderAssistantAttachment,
        readAssistantImageFile,
        addAssistantMessage
    } = tools;

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
            <div class="q3vl-assistant-head"><div><strong>LLM 提示词助手</strong><span>Gemini 原生多模态 + 工具编辑</span></div><button type="button" id="q3vl_assistant_close" class="q3vl-assistant-close" title="关闭">×</button></div>
            <details class="q3vl-assistant-config">
                <summary><span>设置</span><span class="q3vl-assistant-config-hint">Moyuu Gemini 原生多模态</span></summary>
                <div class="q3vl-assistant-settings q3vl-assistant-settings-basic">
                    <select data-q3vl-setting="backend">
                        <option value="moyuu">文本: Moyuu Gemini</option>
                        <option value="deepseek">文本: DeepSeek</option>
                        <option value="local-qwen-once">文本: 本地 Qwen 一次性</option>
                        <option value="local-lmcpp">文本: 本地 endpoint</option>
                    </select>
                    <input data-q3vl-setting="api_key" placeholder="API key" type="password">
                    <select data-q3vl-setting="vision_preset" data-q3vl-field="local-vision" title="仅 DeepSeek/本地文本后端的附图 fallback 使用">
                        <option value="Gemma 4 12B">本地视觉 fallback: Gemma 4 12B</option>
                        <option value="Qwen3.5 原版 9B">本地视觉 fallback: Qwen3.5 原版 9B</option>
                        <option value="Qwen3.5 破限版 9B">本地视觉 fallback: Qwen3.5 破限版 9B</option>
                        <option value="自定义">本地视觉 fallback: 自定义</option>
                    </select>
                    <select data-q3vl-setting="vision_thinking" data-q3vl-field="local-vision" title="仅本地视觉 fallback 使用">
                        <option value="0">本地视觉 thinking off</option>
                        <option value="1">本地视觉 thinking on</option>
                    </select>
                </div>
                <details class="q3vl-assistant-advanced">
                    <summary>高级</summary>
                    <div class="q3vl-assistant-settings q3vl-assistant-settings-advanced">
                        <input data-q3vl-setting="endpoint" data-q3vl-field="remote" placeholder="Moyuu/Gemini endpoint">
                        <input data-q3vl-setting="fallback_endpoint" data-q3vl-field="remote" placeholder="fallback endpoint">
                        <input data-q3vl-setting="model" data-q3vl-field="remote" placeholder="Gemini model">
                        <select data-q3vl-setting="sanitize_sensitive" data-q3vl-field="remote" title="发送到 Gemini 前把敏感提示词替换为占位符，返回工具参数时本地还原">
                            <option value="1">Gemini 脱敏占位符 on</option>
                            <option value="0">Gemini 脱敏占位符 off</option>
                        </select>
                        <input data-q3vl-setting="max_tokens" placeholder="Max tokens">
                        <select data-q3vl-setting="reasoning_effort" data-q3vl-field="remote">
                            <option value="high">Thinking high</option>
                            <option value="max">Thinking max</option>
                        </select>
                        <input data-q3vl-setting="local_endpoint" data-q3vl-field="local-text" placeholder="text local endpoint">
                        <input data-q3vl-setting="local_model" data-q3vl-field="local-text" placeholder="text local model">
                        <input data-q3vl-setting="vision_endpoint" data-q3vl-field="vision-advanced" placeholder="vision endpoint override">
                        <input data-q3vl-setting="vision_model" data-q3vl-field="vision-advanced" placeholder="vision model alias">
                        <input data-q3vl-setting="vision_model_path" data-q3vl-field="vision-custom" placeholder="vision GGUF path">
                        <input data-q3vl-setting="vision_mmproj_path" data-q3vl-field="vision-custom" placeholder="vision mmproj path">
                    </div>
                </details>
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
        const storedBackend = localStorage.getItem("q3vl_assistant_backend");
        const storedEndpointValue = localStorage.getItem("q3vl_assistant_endpoint");
        const storedModelValue = localStorage.getItem("q3vl_assistant_model");
        const migrateDeepSeekDefault = storedBackend === "deepseek" && (!storedEndpointValue || storedEndpointValue === DEEPSEEK_ASSISTANT_ENDPOINT) && (!storedModelValue || KNOWN_ASSISTANT_MODELS.includes(storedModelValue));
        backend.value = migrateDeepSeekDefault ? "moyuu" : storedBackend || "moyuu";
        const endpointInput = panel.querySelector('[data-q3vl-setting="endpoint"]');
        const fallbackInput = panel.querySelector('[data-q3vl-setting="fallback_endpoint"]');
        const modelInput = panel.querySelector('[data-q3vl-setting="model"]');
        endpointInput.value = storedAssistantEndpoint();
        fallbackInput.value = localStorage.getItem("q3vl_assistant_fallback_endpoint") || MOYUU_ASSISTANT_FALLBACK_ENDPOINT;
        modelInput.value = storedAssistantModel(endpointInput.value);
        if (modelInput.value !== localStorage.getItem("q3vl_assistant_model")) {
            localStorage.setItem("q3vl_assistant_model", modelInput.value);
        }
        loadAssistantApiKey(panel, backend.value);
        panel.querySelector('[data-q3vl-setting="max_tokens"]').value = String(normalizeAssistantMaxTokens(localStorage.getItem("q3vl_assistant_max_tokens") || "8192"));
        panel.querySelector('[data-q3vl-setting="sanitize_sensitive"]').value = localStorage.getItem("q3vl_assistant_sanitize_sensitive") || "1";
        panel.querySelector('[data-q3vl-setting="reasoning_effort"]').value = localStorage.getItem("q3vl_assistant_reasoning_effort") || "high";
        panel.querySelector('[data-q3vl-setting="local_endpoint"]').value = localStorage.getItem("q3vl_assistant_local_endpoint") || "http://127.0.0.1:8080/v1";
        panel.querySelector('[data-q3vl-setting="local_model"]').value = localStorage.getItem("q3vl_assistant_local_model") || "hauhau-qwen3.5-9b-uncensored";
        const visionPreset = panel.querySelector('[data-q3vl-setting="vision_preset"]');
        const visionModel = panel.querySelector('[data-q3vl-setting="vision_model"]');
        visionPreset.value = localStorage.getItem("q3vl_assistant_vision_preset") || defaultVisionPreset();
        panel.querySelector('[data-q3vl-setting="vision_thinking"]').value = localStorage.getItem("q3vl_assistant_vision_thinking") || "0";
        panel.querySelector('[data-q3vl-setting="vision_endpoint"]').value = localStorage.getItem("q3vl_assistant_vision_endpoint") || "http://127.0.0.1:8080/v1";
        visionModel.value = localStorage.getItem("q3vl_assistant_vision_model") || visionModelForPreset(visionPreset.value);
        panel.querySelector('[data-q3vl-setting="vision_model_path"]').value = localStorage.getItem("q3vl_assistant_vision_model_path") || "";
        panel.querySelector('[data-q3vl-setting="vision_mmproj_path"]').value = localStorage.getItem("q3vl_assistant_vision_mmproj_path") || "";
        visionPreset.addEventListener("change", function () {
            if (!visionModel.value || Object.values(q3vlVisionPresets).includes(visionModel.value)) {
                visionModel.value = visionModelForPreset(visionPreset.value);
            }
            setAssistantSettingsVisibility(panel);
        });
        panel.querySelectorAll("[data-q3vl-setting]").forEach(function (input) {
            input.addEventListener("change", saveAssistantConfig);
            input.addEventListener("input", saveAssistantConfig);
            input.addEventListener("change", function () { setAssistantSettingsVisibility(panel); });
        });
        backend.addEventListener("change", function () {
            storeAssistantApiKey(panel, assistantState.apiKeyBackend);
            loadAssistantApiKey(panel, backend.value);
            syncAssistantBackendDefaults(panel);
            saveAssistantConfig();
            setAssistantSettingsVisibility(panel);
        });
        syncAssistantBackendDefaults(panel);
        saveAssistantConfig();
        setAssistantSettingsVisibility(panel);
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

    function isMobileViewport() {
        return window.matchMedia("(max-width: 720px), (pointer: coarse)").matches;
    }

    function isVisibleElement(element) {
        return !!(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
    }

    function generationPageVisible() {
        const app = q3vlApp();
        return ["#txt2img_prompt", "#txt2img_settings", "#img2img_prompt", "#img2img_settings"].some(function (selector) {
            return isVisibleElement(app.querySelector(selector));
        });
    }

    function pullRefreshGuardActive() {
        return !!q3vlMainApp() && isMobileViewport() && generationPageVisible();
    }

    function nearestScrollableElement(node) {
        let current = node instanceof Element ? node : node?.parentElement;
        while (current && current !== document.body && current !== document.documentElement) {
            const style = window.getComputedStyle(current);
            if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight + 1) return current;
            current = current.parentElement;
        }
        return document.scrollingElement || document.documentElement;
    }

    function setupPullRefreshGuard() {
        document.documentElement.classList.toggle("q3vl-no-pull-refresh", pullRefreshGuardActive());
        if (document.documentElement.dataset.q3vlPullRefreshBound === "1") return;
        document.documentElement.dataset.q3vlPullRefreshBound = "1";

        let startX = 0;
        let startY = 0;
        document.addEventListener("touchstart", function (event) {
            if (!event.touches || !event.touches.length) return;
            startX = event.touches[0].clientX;
            startY = event.touches[0].clientY;
        }, { passive: true, capture: true });
        document.addEventListener("touchmove", function (event) {
            if (!pullRefreshGuardActive() || !event.touches || !event.touches.length) return;
            const dx = event.touches[0].clientX - startX;
            const dy = event.touches[0].clientY - startY;
            if (dy <= 0 || Math.abs(dx) > dy) return;
            const scrollable = nearestScrollableElement(event.target);
            const page = document.scrollingElement || document.documentElement;
            if (scrollable.scrollTop > 0 || (scrollable === page && page.scrollTop > 0)) return;
            event.preventDefault();
        }, { passive: false, capture: true });
        window.addEventListener("resize", setupPullRefreshGuard);
    }

    function setupQwenTools() {
        if (!q3vlMainApp()) {
            removeAssistantWindow();
            setupPullRefreshGuard();
            return;
        }
        setupQwenPresetGate();
        setupSendButtons();
        setupAssistantWindow();
        setupPullRefreshGuard();
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
