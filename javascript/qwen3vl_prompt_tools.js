(function () {
    function q3vlApp() {
        return typeof gradioApp === "function" ? gradioApp() : document;
    }

    function currentForgePreset() {
        const preset = q3vlApp().querySelector("#forge_ui_preset");
        if (!preset) return "";

        const checked = preset.querySelector("input:checked");
        if (checked) return checked.value;

        const input = preset.querySelector("input");
        if (input) return input.value;

        const select = preset.querySelector("select");
        return select ? select.value : "";
    }

    function syncQwenPromptActions() {
        const visible = currentForgePreset() === "krea";
        q3vlApp().querySelectorAll(".q3vl-inline-actions").forEach(function (row) {
            row.classList.toggle("q3vl-hidden", !visible);
            row.querySelectorAll("button").forEach(function (button) {
                button.disabled = !visible;
                button.title = visible ? "" : "Qwen3-VL 扩写仅在 UI Preset = krea 时可用";
            });
        });
    }

    function setupQwenPresetGate() {
        syncQwenPromptActions();

        const preset = q3vlApp().querySelector("#forge_ui_preset");
        if (preset && !preset.dataset.q3vlPresetGate) {
            preset.dataset.q3vlPresetGate = "1";
            preset.addEventListener("change", syncQwenPromptActions, true);
            preset.addEventListener("input", syncQwenPromptActions, true);
            preset.addEventListener("click", function () {
                window.setTimeout(syncQwenPromptActions, 0);
            }, true);
        }
    }

    function textboxValue(root) {
        if (!root) return "";
        const textarea = root.querySelector("textarea");
        const input = root.querySelector("input");
        return textarea ? textarea.value : input ? input.value : "";
    }

    function setTextboxValue(root, value) {
        if (!root) return false;
        const target = root.querySelector("textarea") || root.querySelector("input");
        if (!target) return false;
        target.value = value;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    }

    function flashButton(root, text) {
        const button = root ? root.querySelector("button") || root : null;
        if (!button) return;
        const original = button.textContent;
        button.textContent = text;
        window.setTimeout(function () {
            button.textContent = original;
        }, 1100);
    }

    function switchMainTab(kind) {
        if (kind === "txt2img" && typeof switch_to_txt2img === "function") {
            switch_to_txt2img();
            return;
        }
        if (kind === "img2img" && typeof switch_to_img2img === "function") {
            switch_to_img2img();
            return;
        }
        const tabs = q3vlApp().querySelector("#tabs");
        const buttons = tabs ? tabs.querySelectorAll("button") : [];
        const index = kind === "txt2img" ? 0 : 1;
        if (buttons[index]) buttons[index].click();
    }

    function sendReversePrompt(kind) {
        const app = q3vlApp();
        const source = app.querySelector("#q3vl_reverse_output");
        const target = app.querySelector(kind === "txt2img" ? "#txt2img_prompt" : "#img2img_prompt");
        const value = textboxValue(source).trim();
        if (!value) return;
        if (setTextboxValue(target, value)) {
            switchMainTab(kind);
        }
    }

    function setupSendButtons() {
        const app = q3vlApp();
        const txt = app.querySelector("#q3vl_send_txt2img");
        const img = app.querySelector("#q3vl_send_img2img");
        if (txt && !txt.dataset.q3vlSendBound) {
            txt.dataset.q3vlSendBound = "1";
            txt.addEventListener("click", function () {
                window.setTimeout(function () {
                    sendReversePrompt("txt2img");
                    flashButton(txt, "已发送");
                }, 0);
            }, true);
        }
        if (img && !img.dataset.q3vlSendBound) {
            img.dataset.q3vlSendBound = "1";
            img.addEventListener("click", function () {
                window.setTimeout(function () {
                    sendReversePrompt("img2img");
                    flashButton(img, "已发送");
                }, 0);
            }, true);
        }
    }

    const assistantState = {
        messages: []
    };

    function assistantConfig() {
        const panel = q3vlApp().querySelector("#q3vl_assistant_panel");
        const get = function (name, fallback) {
            const value = panel ? panel.querySelector(`[data-q3vl-setting="${name}"]`)?.value : localStorage.getItem(`q3vl_assistant_${name}`);
            return value || fallback;
        };
        return {
            backend: get("backend", "deepseek"),
            endpoint: get("endpoint", "https://api.deepseek.com/v1"),
            model: get("model", "deepseekv4-pro"),
            api_key: get("api_key", ""),
            local_endpoint: get("local_endpoint", "http://127.0.0.1:8080/v1"),
            local_model: get("local_model", "hauhau-qwen3.5-9b-uncensored"),
            temperature: 0.35,
            top_p: 0.9,
            max_tokens: 768,
            timeout: 120
        };
    }

    function saveAssistantConfig() {
        const panel = q3vlApp().querySelector("#q3vl_assistant_panel");
        if (!panel) return;
        panel.querySelectorAll("[data-q3vl-setting]").forEach(function (input) {
            localStorage.setItem(`q3vl_assistant_${input.dataset.q3vlSetting}`, input.value || "");
        });
    }

    function activePromptTarget() {
        const tabs = q3vlApp().querySelector("#tabs");
        const selected = tabs ? Array.from(tabs.querySelectorAll("button")).find(function (button) {
            return button.getAttribute("aria-selected") === "true" || button.classList.contains("selected");
        }) : null;
        const text = selected ? selected.textContent.toLowerCase() : "";
        return text.includes("img2img") ? "img2img" : "txt2img";
    }

    function promptRootForTarget(target) {
        const resolved = target === "active" || !target ? activePromptTarget() : target;
        return {
            target: resolved,
            root: q3vlApp().querySelector(resolved === "img2img" ? "#img2img_prompt" : "#txt2img_prompt")
        };
    }

    function executeAssistantTool(tool) {
        const name = tool.tool || tool.name;
        const args = tool.arguments || {};
        if (name === "get_current_prompt") {
            const item = promptRootForTarget(args.target || "active");
            return { ok: true, target: item.target, prompt: textboxValue(item.root) };
        }
        if (name === "set_current_prompt") {
            const item = promptRootForTarget(args.target || "active");
            const prompt = String(args.prompt || "");
            if (!prompt.trim()) return { ok: false, error: "prompt is empty" };
            const ok = setTextboxValue(item.root, prompt);
            if (ok) switchMainTab(item.target);
            return { ok: ok, target: item.target, prompt: prompt };
        }
        return { ok: false, error: `unknown tool: ${name}` };
    }

    function parseAssistantTool(text) {
        let raw = String(text || "").trim();
        raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        try {
            const parsed = JSON.parse(raw);
            if (parsed && (parsed.tool || parsed.name)) return parsed;
        } catch (_error) {
            const match = raw.match(/\{[\s\S]*\}/);
            if (match) {
                try {
                    const parsed = JSON.parse(match[0]);
                    if (parsed && (parsed.tool || parsed.name)) return parsed;
                } catch (_ignored) { }
            }
        }
        return null;
    }

    function addAssistantMessage(role, text) {
        const log = q3vlApp().querySelector("#q3vl_assistant_messages");
        if (!log) return;
        const item = document.createElement("div");
        item.className = `q3vl-assistant-msg q3vl-assistant-${role}`;
        item.textContent = text;
        log.appendChild(item);
        log.scrollTop = log.scrollHeight;
    }

    async function callPromptAssistant() {
        const payload = Object.assign(assistantConfig(), { messages: assistantState.messages });
        const response = await fetch("/qwen3vl-prompt-tools/assistant", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const detail = await response.text();
            throw new Error(detail);
        }
        return await response.json();
    }

    async function runAssistantLoop(userText) {
        if (userText) {
            assistantState.messages.push({ role: "user", content: userText });
            addAssistantMessage("user", userText);
        }
        const sendButton = q3vlApp().querySelector("#q3vl_assistant_send");
        if (sendButton) sendButton.disabled = true;
        try {
            for (let i = 0; i < 4; i += 1) {
                addAssistantMessage("status", "思考中...");
                const result = await callPromptAssistant();
                const text = result.text || "";
                const tool = parseAssistantTool(text);
                if (!tool) {
                    assistantState.messages.push({ role: "assistant", content: text });
                    addAssistantMessage("assistant", text);
                    return;
                }
                assistantState.messages.push({ role: "assistant", content: text });
                const toolResult = executeAssistantTool(tool);
                addAssistantMessage("tool", `工具 ${tool.tool || tool.name}: ${toolResult.ok ? "完成" : "失败"}`);
                assistantState.messages.push({ role: "user", content: `Tool result for ${tool.tool || tool.name}: ${JSON.stringify(toolResult)}` });
            }
            addAssistantMessage("assistant", "工具调用次数过多，已停止。请换一种更直接的指令。比如：读取当前提示词并改成三人自拍构图。 ");
        } catch (error) {
            addAssistantMessage("error", String(error.message || error));
        } finally {
            if (sendButton) sendButton.disabled = false;
        }
    }

    function setupAssistantWindow() {
        const app = q3vlApp();
        if (app.querySelector("#q3vl_assistant_launcher")) return;
        const launcher = document.createElement("button");
        launcher.id = "q3vl_assistant_launcher";
        launcher.type = "button";
        launcher.textContent = "LLM 助手";
        document.body.appendChild(launcher);

        const panel = document.createElement("div");
        panel.id = "q3vl_assistant_panel";
        panel.innerHTML = `
            <div class="q3vl-assistant-head"><strong>LLM 提示词助手</strong><button type="button" id="q3vl_assistant_close">×</button></div>
            <div class="q3vl-assistant-settings">
                <select data-q3vl-setting="backend">
                    <option value="deepseek">DeepSeek / OpenAI-compatible</option>
                    <option value="local-lmcpp">本地 llama.cpp endpoint</option>
                </select>
                <input data-q3vl-setting="endpoint" placeholder="DeepSeek endpoint">
                <input data-q3vl-setting="model" placeholder="DeepSeek model">
                <input data-q3vl-setting="api_key" placeholder="API key" type="password">
                <input data-q3vl-setting="local_endpoint" placeholder="local lmcpp endpoint">
                <input data-q3vl-setting="local_model" placeholder="local model">
            </div>
            <div id="q3vl_assistant_messages"></div>
            <textarea id="q3vl_assistant_input" placeholder="例如：读取当前提示词，改成三名角色的自拍构图，明确左中右位置。"></textarea>
            <div class="q3vl-assistant-actions"><button type="button" id="q3vl_assistant_read">读取当前 prompt</button><button type="button" id="q3vl_assistant_clear">清空</button><button type="button" id="q3vl_assistant_send">发送</button></div>
        `;
        document.body.appendChild(panel);
        restoreAssistantPosition(panel);
        const backend = panel.querySelector('[data-q3vl-setting="backend"]');
        backend.value = localStorage.getItem("q3vl_assistant_backend") || "deepseek";
        panel.querySelector('[data-q3vl-setting="endpoint"]').value = localStorage.getItem("q3vl_assistant_endpoint") || "https://api.deepseek.com/v1";
        panel.querySelector('[data-q3vl-setting="model"]').value = localStorage.getItem("q3vl_assistant_model") || "deepseekv4-pro";
        panel.querySelector('[data-q3vl-setting="api_key"]').value = localStorage.getItem("q3vl_assistant_api_key") || "";
        panel.querySelector('[data-q3vl-setting="local_endpoint"]').value = localStorage.getItem("q3vl_assistant_local_endpoint") || "http://127.0.0.1:8080/v1";
        panel.querySelector('[data-q3vl-setting="local_model"]').value = localStorage.getItem("q3vl_assistant_local_model") || "hauhau-qwen3.5-9b-uncensored";
        panel.querySelectorAll("[data-q3vl-setting]").forEach(function (input) {
            input.addEventListener("change", saveAssistantConfig);
            input.addEventListener("input", saveAssistantConfig);
        });
        launcher.addEventListener("click", function () { panel.classList.toggle("q3vl-assistant-open"); });
        panel.querySelector("#q3vl_assistant_close").addEventListener("click", function () { panel.classList.remove("q3vl-assistant-open"); });
        makeAssistantDraggable(panel, panel.querySelector(".q3vl-assistant-head"));
        panel.querySelector("#q3vl_assistant_send").addEventListener("click", function () {
            const input = panel.querySelector("#q3vl_assistant_input");
            const text = input.value.trim();
            if (!text) return;
            input.value = "";
            runAssistantLoop(text);
        });
        panel.querySelector("#q3vl_assistant_input").addEventListener("keydown", function (event) {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                panel.querySelector("#q3vl_assistant_send").click();
            }
        });
        panel.querySelector("#q3vl_assistant_read").addEventListener("click", function () {
            runAssistantLoop("Read the current prompt and briefly summarize what composition and spatial relationships it currently describes. If it is empty, say it is empty.");
        });
        panel.querySelector("#q3vl_assistant_clear").addEventListener("click", function () {
            assistantState.messages = [];
            panel.querySelector("#q3vl_assistant_messages").textContent = "";
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

    function setupQwenTools() {
        setupQwenPresetGate();
        setupSendButtons();
        setupAssistantWindow();
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
