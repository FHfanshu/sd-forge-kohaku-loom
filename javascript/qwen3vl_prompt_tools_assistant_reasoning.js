(function () {
    const tools = window.q3vlPromptTools = window.q3vlPromptTools || {};
    const FALLBACK_LEVELS = ["low", "medium", "high", "max"];

    function t(key, fallback) {
        const value = typeof tools.tr === "function" ? tools.tr(key) : "";
        return value && value !== key ? value : fallback;
    }

    function effortLabel(value) {
        const labels = {
            none: ["settings.reasoning_none", "关闭"], minimal: ["settings.reasoning_minimal", "最小"],
            low: ["settings.reasoning_low", "低"], medium: ["settings.reasoning_medium", "中"],
            high: ["settings.reasoning_high", "高"], xhigh: ["settings.reasoning_xhigh", "极高"], max: ["settings.reasoning_max", "最大"]
        };
        const item = labels[value] || labels.low;
        return t(item[0], item[1]);
    }

    function activeProfile() {
        return tools.profileStore?.current?.() || null;
    }

    function availableLevels(profile) {
        const info = profile?.model_info || {};
        const source = Array.isArray(info.reasoning_efforts) && info.reasoning_efforts.length ? info.reasoning_efforts : FALLBACK_LEVELS;
        return source.filter(function (value, index) { return value !== "none" && source.indexOf(value) === index; });
    }

    function persistEffort(value) {
        const profile = activeProfile();
        if (!profile) return;
        tools.profileStore.update(profile.id, { parameters: { reasoning_effort: value } });
        window.dispatchEvent?.(new CustomEvent("q3vl:model-profiles-changed", { detail: tools.profileStore.load() }));
    }

    function buildPopover(button) {
        const popover = document.createElement("div");
        popover.id = "q3vl_assistant_reasoning_popover";
        popover.className = "q3vl-assistant-reasoning-popover";
        popover.hidden = true;
        popover.setAttribute("role", "dialog");
        popover.setAttribute("aria-label", t("settings.reasoning_effort", "推理强度"));
        popover.innerHTML = `
            <div class="q3vl-reasoning-heading"><span>${t("settings.reasoning_effort", "推理强度")}</span><strong data-q3vl-effort-label></strong></div>
            <label class="q3vl-reasoning-toggle"><span>${t("settings.reasoning_enable", "启用思考")}</span><input type="checkbox"><i aria-hidden="true"></i></label>
            <div class="q3vl-reasoning-scale-labels"><span>${t("settings.reasoning_faster", "更快")}</span><span>${t("settings.reasoning_smarter", "更聪明")}</span></div>
            <div class="q3vl-reasoning-range-wrap"><div class="q3vl-reasoning-dots" aria-hidden="true"></div><input type="range" min="0" max="3" step="1" value="0" aria-label="${t("settings.reasoning_effort", "推理强度")}"></div>`;
        button.parentElement.appendChild(popover);
        const toggle = popover.querySelector('input[type="checkbox"]');
        const range = popover.querySelector('input[type="range"]');
        toggle.addEventListener("change", function () {
            const profile = activeProfile();
            const levels = availableLevels(profile);
            const remembered = button.dataset.q3vlLastEffort;
            const next = toggle.checked ? (levels.includes(remembered) ? remembered : levels[Math.min(1, levels.length - 1)] || "low") : "none";
            persistEffort(next);
        });
        range.addEventListener("input", function () {
            const levels = availableLevels(activeProfile());
            const value = levels[Math.max(0, Math.min(levels.length - 1, Number(range.value)))] || "low";
            popover.querySelector("[data-q3vl-effort-label]").textContent = effortLabel(value);
        });
        range.addEventListener("change", function () {
            const levels = availableLevels(activeProfile());
            persistEffort(levels[Number(range.value)] || "low");
        });
        return popover;
    }

    function syncAssistantReasoningControl() {
        const button = document.querySelector("#q3vl_assistant_reasoning");
        if (!button) return;
        const profile = activeProfile();
        const supported = profile?.capabilities?.reasoning !== false;
        const effort = supported ? (profile?.parameters?.reasoning_effort || "low") : "none";
        const levels = availableLevels(profile);
        const info = profile?.model_info || {};
        const canDisable = info.source !== "models.dev" || info.reasoning_toggle || info.reasoning_efforts?.includes("none");
        if (effort !== "none") button.dataset.q3vlLastEffort = effort;
        button.dataset.q3vlEffort = effort;
        button.disabled = !supported;
        button.querySelector("span").textContent = effortLabel(effort);
        button.title = `${t("settings.reasoning_effort", "推理强度")}: ${effortLabel(effort)}`;
        button.setAttribute("aria-label", button.title);
        const popover = document.querySelector("#q3vl_assistant_reasoning_popover");
        if (!popover) return;
        const toggle = popover.querySelector('input[type="checkbox"]');
        const range = popover.querySelector('input[type="range"]');
        const currentIndex = Math.max(0, levels.indexOf(effort === "none" ? button.dataset.q3vlLastEffort : effort));
        toggle.checked = effort !== "none";
        toggle.disabled = !supported;
        toggle.closest("label").hidden = !canDisable;
        range.disabled = effort === "none" || !supported;
        range.max = String(Math.max(0, levels.length - 1));
        range.value = String(Math.min(currentIndex, levels.length - 1));
        popover.querySelector("[data-q3vl-effort-label]").textContent = effortLabel(effort);
        const dots = popover.querySelector(".q3vl-reasoning-dots");
        dots.replaceChildren(...levels.map(function () { const dot = document.createElement("i"); return dot; }));
        dots.style.gridTemplateColumns = `repeat(${Math.max(levels.length, 1)}, 1fr)`;
    }

    function setupAssistantReasoningControl(panel) {
        const button = panel?.querySelector("#q3vl_assistant_reasoning");
        if (!button || button.dataset.q3vlReasoningBound === "1") return;
        button.dataset.q3vlReasoningBound = "1";
        button.setAttribute("aria-haspopup", "dialog");
        button.setAttribute("aria-expanded", "false");
        const popover = buildPopover(button);
        button.addEventListener("click", function () {
            popover.hidden = !popover.hidden;
            button.setAttribute("aria-expanded", String(!popover.hidden));
            if (!popover.hidden) popover.querySelector('input:not(:disabled)')?.focus();
        });
        document.addEventListener("pointerdown", function (event) {
            if (popover.hidden || popover.contains(event.target) || button.contains(event.target)) return;
            popover.hidden = true;
            button.setAttribute("aria-expanded", "false");
        });
        popover.addEventListener("keydown", function (event) {
            if (event.key !== "Escape") return;
            popover.hidden = true;
            button.setAttribute("aria-expanded", "false");
            button.focus();
        });
        syncAssistantReasoningControl();
    }

    Object.assign(tools, { assistantEffortLabel: effortLabel, assistantReasoningLevels: availableLevels, setupAssistantReasoningControl, syncAssistantReasoningControl });
})();
