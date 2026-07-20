(function () {
    const tools = window.__SD_FORGE_NEO_PROMPT_AGENT__;
    if (!tools) return;
    const {
        assistantState,
        promptContextSnapshot,
        promptFieldRootForTarget,
        promptAgentApp,
        readPromptTool,
        positivePromptNoPhrases,
        setNativeValueIfAvailable,
        setTextboxValue,
        styleSelectorValue
    } = tools;

    const RESOURCE_TOOLS = new Set([
        "search_resources",
        "inspect_resource",
        "apply_resource",
        "initialize_prompt",
        "load_prompt_skill",
        "search_danbooru_tags",
        "inspect_danbooru_tag",
        "inspect_danbooru_tags",
        "related_danbooru_tags"
    ]);

    function wait(ms) {
        return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
    }

    function resolvedTarget(target) {
        return promptFieldRootForTarget(target || "active", "positive").target;
    }

    function queryUrl(path, params) {
        const url = new URL(path, window.location.origin);
        Object.entries(params || {}).forEach(function (entry) {
            const value = entry[1];
            if (value !== undefined && value !== null && value !== "") url.searchParams.set(entry[0], String(value));
        });
        return url.pathname + url.search;
    }

    async function resourceGet(path, params, signal) {
        const response = await fetch(queryUrl(path, params), { signal: signal });
        if (!response.ok) {
            let detail = await response.text();
            try {
                const parsed = JSON.parse(detail);
                detail = parsed.detail || detail;
            } catch (_error) { }
            return { ok: false, error: String(detail || `HTTP ${response.status}`) };
        }
        return await response.json();
    }

    async function searchResourcesTool(args, signal) {
        return await resourceGet("/prompt-agent/api/resources/search", {
            kind: args.kind,
            query: args.query || "",
            limit: args.limit || 20,
            cursor: args.cursor || ""
        }, signal);
    }

    async function inspectResourceTool(args, signal) {
        return await resourceGet("/prompt-agent/api/resources/inspect", {
            kind: args.kind,
            id: args.id,
            query: args.query || "",
            limit: args.limit || 20,
            cursor: args.cursor || ""
        }, signal);
    }

    async function loadPromptSkillTool(args, signal) {
        const name = String(args.name || "").trim().toLowerCase().replace(/[- ]/g, "_");
        if (!name) return { ok: false, error: "load_prompt_skill requires name" };
        if (assistantState.loadedPromptSkills[name]) return assistantState.loadedPromptSkills[name];
        const result = await resourceGet(`/prompt-agent/api/prompt-skills/${encodeURIComponent(name)}`, {}, signal);
        if (result.ok) assistantState.loadedPromptSkills[name] = result;
        return result;
    }

    async function searchDanbooruTagsTool(args, signal) {
        const queries = Array.isArray(args.queries) ? JSON.stringify(args.queries) : "";
        return await resourceGet("/prompt-agent/api/danbooru/tags/search", {
            query: args.query || "",
            queries: queries,
            category: args.category || "",
            limit: args.limit || 12
        }, signal);
    }

    async function inspectDanbooruTagTool(args, signal) {
        return await resourceGet("/prompt-agent/api/danbooru/tags/inspect", { name: args.name || "" }, signal);
    }

    async function inspectDanbooruTagsTool(args, signal) {
        const names = Array.isArray(args.names) ? args.names.join(",") : "";
        return await resourceGet("/prompt-agent/api/danbooru/tags/inspect-batch", { names: names, include_wiki: !!args.include_wiki }, signal);
    }

    async function relatedDanbooruTagsTool(args, signal) {
        return await resourceGet("/prompt-agent/api/danbooru/tags/related", {
            name: args.name || "",
            category: args.category || "",
            limit: args.limit || 12
        }, signal);
    }

    function resourceMutationGuard(args) {
        const target = resolvedTarget(args.target);
        const readState = assistantState.promptReads[target];
        const expected = String(args.context_hash || "").trim();
        if (!readState) return { ok: false, target: target, error: "must call read_prompt before changing resources" };
        if (!expected) return { ok: false, target: target, error: "context_hash from read_prompt is required" };
        if (expected !== readState.context_hash) {
            return { ok: false, target: target, error: "context_hash does not match the latest read_prompt; read again", latest_context_hash: readState.context_hash };
        }
        const actual = promptContextSnapshot(target);
        if (expected !== actual.context_hash) {
            return { ok: false, target: target, error: "prompt, Styles, checkpoint, or preset changed after read_prompt; read again", actual_context_hash: actual.context_hash };
        }
        return { ok: true, target: target, state: actual };
    }

    function appendFragment(current, fragment) {
        const base = String(current || "").trim();
        const addition = String(fragment || "").trim();
        if (!addition || base.includes(addition)) return { value: base, changed: false };
        return { value: base ? `${base}, ${addition}` : addition, changed: true };
    }

    function writePromptField(target, field, value) {
        if (field === "positive" && positivePromptNoPhrases(value).length) return false;
        const item = promptFieldRootForTarget(target, field);
        if (!item.root) return false;
        return setTextboxValue(item.root, value);
    }

    function formatWeight(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return "1";
        return String(Math.round(number * 10000) / 10000);
    }

    async function addStyleSelection(target, styleName) {
        const root = promptAgentApp().querySelector(`#${target}_styles`);
        if (!root) return { ok: false, error: `${target} Styles selector is unavailable` };
        const current = styleSelectorValue(target);
        const normalized = String(styleName || "").trim().toLowerCase();
        const selected = String(current || "").split(/[\n,]/).map(function (value) { return value.trim().toLowerCase(); });
        if (selected.includes(normalized)) return { ok: true, changed: false, selected_styles: current };

        const input = root.querySelector("input[role='combobox'], input[autocomplete='off'], label > div input, input:not([type])");
        if (!input) return { ok: false, error: "Styles combobox input is unavailable" };
        input.focus();
        setNativeValueIfAvailable(input, styleName);
        await wait(30);
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
        await wait(100);

        let updated = styleSelectorValue(target);
        if (!String(updated || "").toLowerCase().includes(normalized)) {
            const option = Array.from(promptAgentApp().querySelectorAll("[role='option'], [data-testid='option']")).find(function (node) {
                return String(node.textContent || "").trim().toLowerCase() === normalized;
            });
            if (option) option.click();
            await wait(100);
            updated = styleSelectorValue(target);
        }
        if (!String(updated || "").toLowerCase().includes(normalized)) {
            setNativeValueIfAvailable(input, "");
            return { ok: false, error: `Forge did not accept Style selection: ${styleName}` };
        }
        return { ok: true, changed: true, selected_styles: updated };
    }

    async function applyResourceTool(args, signal) {
        const guard = resourceMutationGuard(args);
        if (!guard.ok) return guard;
        const kind = String(args.kind || "").toLowerCase();
        const resource = await inspectResourceTool({ kind: kind, id: args.id, limit: 20 }, signal);
        if (!resource.ok) return resource;
        const latestGuard = resourceMutationGuard(args);
        if (!latestGuard.ok) return latestGuard;
        const target = latestGuard.target;
        const applied = [];

        if (kind === "style") {
            const styleResult = await addStyleSelection(target, resource.name);
            if (!styleResult.ok) return Object.assign({ target: target, kind: kind, id: resource.id }, styleResult);
            if (styleResult.changed) applied.push(`Style: ${resource.name}`);
        } else if (kind === "wildcard") {
            const next = appendFragment(latestGuard.state.positive, resource.token);
            if (next.changed && !writePromptField(target, "positive", next.value)) return { ok: false, target: target, error: "positive prompt field is unavailable" };
            if (next.changed) applied.push(resource.token);
        } else if (kind === "lora") {
            const weight = args.weight === undefined ? resource.preferred_weight : args.weight;
            const token = `<lora:${resource.alias || resource.name}:${formatWeight(weight)}>`;
            let positive = appendFragment(latestGuard.state.positive, token);
            let positiveChanged = positive.changed;
            if (resource.activation_text) {
                const withActivation = appendFragment(positive.value, resource.activation_text);
                positiveChanged = positiveChanged || withActivation.changed;
                positive = withActivation;
            }
            const negative = appendFragment(latestGuard.state.negative, resource.negative_text);
            if (positiveChanged && !writePromptField(target, "positive", positive.value)) return { ok: false, target: target, error: "positive prompt field is unavailable" };
            if (negative.changed && !writePromptField(target, "negative", negative.value)) return { ok: false, target: target, error: "negative prompt field is unavailable" };
            if (positiveChanged) applied.push(token, resource.activation_text || "");
            if (negative.changed) applied.push(`negative: ${resource.negative_text}`);
        } else {
            return { ok: false, error: `unknown resource kind: ${kind}` };
        }

        const latest = await readPromptTool(target);
        return {
            ok: true,
            target: target,
            kind: kind,
            id: resource.id,
            changed: applied.filter(Boolean).length > 0,
            applied: applied.filter(Boolean),
            selected_styles: latest.style_selector,
            context_hash: latest.context_hash
        };
    }

    async function initializePromptTool(args) {
        const guard = resourceMutationGuard(args);
        if (!guard.ok) return guard;
        const positive = String(args.positive_prompt || "").trim();
        const negative = String(args.negative_prompt || "").trim();
        const initialized = [];
        const skipped = [];
        if (guard.state.positive.trim()) skipped.push("positive");
        else if (positive && writePromptField(guard.target, "positive", positive)) initialized.push("positive");
        if (guard.state.negative.trim()) skipped.push("negative");
        else if (negative && writePromptField(guard.target, "negative", negative)) initialized.push("negative");
        if (!initialized.length) {
            return { ok: false, target: guard.target, skipped_fields: skipped, error: skipped.length ? "existing prompt content was not overwritten" : "no prompt text supplied" };
        }
        const latest = await readPromptTool(guard.target);
        return { ok: true, target: guard.target, initialized_fields: initialized, skipped_fields: skipped, context_hash: latest.context_hash };
    }

    async function executeResourceTool(tool, signal) {
        const name = tool.tool || tool.name;
        if (!RESOURCE_TOOLS.has(name)) return undefined;
        const args = tool.arguments || {};
        if (name === "search_resources") return await searchResourcesTool(args, signal);
        if (name === "inspect_resource") return await inspectResourceTool(args, signal);
        if (name === "apply_resource") return await applyResourceTool(args, signal);
        if (name === "initialize_prompt") return await initializePromptTool(args);
        if (name === "load_prompt_skill") return await loadPromptSkillTool(args, signal);
        if (name === "search_danbooru_tags") return await searchDanbooruTagsTool(args, signal);
        if (name === "inspect_danbooru_tag") return await inspectDanbooruTagTool(args, signal);
        if (name === "inspect_danbooru_tags") return await inspectDanbooruTagsTool(args, signal);
        if (name === "related_danbooru_tags") return await relatedDanbooruTagsTool(args, signal);
        return undefined;
    }

    Object.assign(tools, {
        RESOURCE_TOOLS,
        queryUrl,
        resourceGet,
        searchResourcesTool,
        inspectResourceTool,
        loadPromptSkillTool,
        searchDanbooruTagsTool,
        inspectDanbooruTagTool,
        inspectDanbooruTagsTool,
        relatedDanbooruTagsTool,
        resourceMutationGuard,
        appendFragment,
        formatWeight,
        addStyleSelection,
        applyResourceTool,
        initializePromptTool,
        executeResourceTool
    });
})();
