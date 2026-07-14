(function () {
    const tools = window.kohakuLoom = window.kohakuLoom || {};
    const MODELS_DEV_URL = "https://models.dev/api.json";
    const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
    let catalogPromise = null;

    function endpointHost(value) {
        try { return new URL(String(value || "")).hostname.toLowerCase(); } catch (_error) { return ""; }
    }

    function providerScore(provider, profile) {
        const endpoint = endpointHost(profile?.endpoint);
        const apiHost = endpointHost(provider?.api);
        let score = endpoint && apiHost && (endpoint === apiHost || endpoint.endsWith(`.${apiHost}`)) ? 100 : 0;
        const id = String(provider?.id || "").toLowerCase();
        if (endpoint.includes(id)) score += 30;
        if (profile?.protocol === "gemini-native" && id === "google") score += 20;
        return score;
    }

    function modelAliases(value) {
        const raw = String(value || "").trim().toLowerCase();
        const aliases = [raw];
        const withoutEffort = raw.replace(/-(?:minimal|low|medium|high|xhigh|max)$/, "");
        if (withoutEffort !== raw) aliases.push(withoutEffort);
        if (raw.includes("/")) aliases.push(raw.split("/").slice(1).join("/"));
        return Array.from(new Set(aliases.filter(Boolean)));
    }

    function findModelsDevModel(catalog, profile) {
        const providers = Object.values(catalog || {}).filter(function (item) { return item && typeof item === "object" && item.models; });
        const aliases = modelAliases(profile?.model_id || profile?.model);
        const matches = [];
        providers.forEach(function (provider) {
            Object.values(provider.models || {}).forEach(function (model) {
                const ids = modelAliases(model?.id);
                if (!aliases.some(function (alias) { return ids.includes(alias); })) return;
                matches.push({ provider: provider, model: model, score: providerScore(provider, profile) });
            });
        });
        matches.sort(function (left, right) { return right.score - left.score; });
        return matches[0] || null;
    }

    function effortValues(model) {
        const values = [];
        let toggle = false;
        (model?.reasoning_options || []).forEach(function (option) {
            if (option?.type === "toggle") toggle = true;
            if (option?.type !== "effort") return;
            const items = Array.isArray(option.values) ? option.values : String(option.values || "").split(/[\s,]+/);
            values.push(...items);
        });
        const efforts = Array.from(new Set(values.map(function (item) { return String(item || "").toLowerCase(); }).filter(function (item) { return EFFORT_ORDER.includes(item); })));
        efforts.sort(function (left, right) { return EFFORT_ORDER.indexOf(left) - EFFORT_ORDER.indexOf(right); });
        return { toggle: toggle, efforts: efforts };
    }

    function modelsDevProfilePatch(match) {
        if (!match?.model || !match?.provider) return null;
        const model = match.model;
        const reasoning = effortValues(model);
        const outputLimit = Number(model.limit?.output) || 0;
        return {
            capabilities: {
                tools: Boolean(model.tool_call),
                vision: Boolean(model.attachment || (model.modalities?.input || []).includes("image")),
                reasoning: Boolean(model.reasoning),
                streaming: true
            },
            parameters: {},
            model_info: {
                source: "models.dev",
                provider_id: String(match.provider.id || ""),
                matched_model_id: String(model.id || ""),
                context_limit: Number(model.limit?.context) || 0,
                output_limit: outputLimit,
                temperature_supported: model.temperature !== false,
                reasoning_toggle: reasoning.toggle,
                reasoning_efforts: reasoning.efforts,
                synced_at: new Date().toISOString()
            }
        };
    }

    function loadModelsDevCatalog(fetchImpl) {
        if (!catalogPromise) {
            const request = fetchImpl || window.fetch.bind(window);
            catalogPromise = request(MODELS_DEV_URL).then(function (response) {
                if (!response.ok) throw new Error(`models.dev ${response.status}`);
                return response.json();
            }).catch(function (error) { catalogPromise = null; throw error; });
        }
        return catalogPromise;
    }

    async function syncProfileFromModelsDev(profile, fetchImpl) {
        const catalog = await loadModelsDevCatalog(fetchImpl);
        const match = findModelsDevModel(catalog, profile);
        if (!match) throw new Error(`models.dev has no exact match for ${profile?.model_id || "this model"}`);
        const patch = modelsDevProfilePatch(match);
        const efforts = patch.model_info.reasoning_efforts;
        const current = String(profile?.parameters?.reasoning_effort || "").toLowerCase();
        const supportsOff = patch.model_info.reasoning_toggle || efforts.includes("none");
        if (efforts.length && !efforts.includes(current) && !(current === "none" && supportsOff)) {
            patch.parameters.reasoning_effort = efforts.find(function (value) { return value !== "none"; }) || "none";
        }
        const maxTokens = Number(profile?.parameters?.max_tokens) || 0;
        if (patch.model_info.output_limit && maxTokens > patch.model_info.output_limit) {
            patch.parameters.max_tokens = patch.model_info.output_limit;
        }
        return { match: match, patch: patch };
    }

    Object.assign(tools, {
        MODELS_DEV_URL,
        MODEL_REASONING_EFFORT_ORDER: EFFORT_ORDER,
        findModelsDevModel,
        modelsDevEffortValues: effortValues,
        modelsDevProfilePatch,
        loadModelsDevCatalog,
        syncProfileFromModelsDev
    });
})();
