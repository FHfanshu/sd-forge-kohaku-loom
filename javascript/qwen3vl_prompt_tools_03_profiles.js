(function () {
    const tools = window.q3vlPromptTools = window.q3vlPromptTools || {};
    const PROFILE_STORAGE_KEY = "q3vl_assistant_profiles_v2";
    const PROFILE_SCHEMA_VERSION = 2;
    const DEFAULT_MODEL_PATH = "E:\\AI\\lmcpp\\models\\Qwen3.5-9B-GGUF\\Qwen3.5-9B-UD-Q6_K_XL.gguf";
    const DEFAULT_MMPROJ_PATH = "E:\\AI\\lmcpp\\models\\Qwen3.5-9B-GGUF\\mmproj-F16.gguf";
    const DEFAULT_SERVER_PATH = "E:\\AI\\lmcpp\\llama.cpp\\llama-server.exe";
    const DEFAULT_LOCAL_ENDPOINT = "http://127.0.0.1:8080/v1";
    const LEGACY_PREFIX = "q3vl_assistant_";
    const LEGACY_SETTING_NAMES = [
        "backend", "teacher_mode", "sanitize_sensitive", "endpoint", "fallback_endpoint", "model",
        "secondary_backend", "secondary_endpoint", "secondary_model", "fallback_backend", "fallback_model",
        "fallback_model_endpoint", "api_key_openai", "api_key_moyuu", "api_key_deepseek", "reasoning_effort",
        "max_tokens", "local_text_thinking", "vision_thinking", "local_max_tokens", "n_ctx",
        "local_temperature", "local_top_p", "local_n_gpu_layers", "local_timeout", "vision_preset",
        "local_endpoint", "local_model", "vision_endpoint", "vision_model", "vision_model_path",
        "vision_mmproj_path", "llama_server_path", "chat_model_route"
    ];

    let generatedIdCounter = 0;

    function deepCloneProfileData(value) {
        if (value === undefined) return undefined;
        return JSON.parse(JSON.stringify(value));
    }

    function defaultCapabilities(vision) {
        return { tools: true, vision: Boolean(vision), streaming: true, reasoning: true };
    }

    function defaultParameters(overrides) {
        return Object.assign({
            temperature: 0.35,
            top_p: 0.9,
            max_tokens: 8192,
            reasoning_effort: "low",
            timeout: 120,
            sanitize_sensitive: true,
            teacher_mode: "qwen-redact"
        }, overrides || {});
    }

    function defaultLocalValues(overrides) {
        return Object.assign({
            model_path: "",
            mmproj_path: "",
            llama_server_path: "",
            n_ctx: 16384,
            n_gpu_layers: -1,
            thinking: false
        }, overrides || {});
    }

    const DEFAULT_PROFILES = [
        {
            id: "moyuu-gemini",
            display_name: "Moyuu Gemini",
            enabled: true,
            protocol: "gemini-native",
            runtime: "remote-http",
            endpoint: "https://moyuu.cc",
            fallback_endpoints: ["https://hk-api.moyuu.cc"],
            model_id: "gemini-3.1-pro-high",
            api_key: "",
            capabilities: defaultCapabilities(true),
            parameters: defaultParameters(),
            ...defaultLocalValues()
        },
        {
            id: "grok",
            display_name: "Grok",
            enabled: true,
            protocol: "openai-chat-completions",
            runtime: "remote-http",
            endpoint: "https://moyuu.cc",
            fallback_endpoints: ["https://hk-api.moyuu.cc"],
            model_id: "grok-4.5",
            api_key: "",
            capabilities: defaultCapabilities(false),
            parameters: defaultParameters(),
            ...defaultLocalValues()
        },
        {
            id: "deepseek",
            display_name: "DeepSeek",
            enabled: true,
            protocol: "openai-chat-completions",
            runtime: "remote-http",
            endpoint: "https://api.deepseek.com",
            fallback_endpoints: [],
            model_id: "deepseek-v4-pro",
            api_key: "",
            capabilities: defaultCapabilities(false),
            parameters: defaultParameters(),
            ...defaultLocalValues()
        },
        {
            id: "local-llama-endpoint",
            display_name: "Local llama endpoint",
            enabled: true,
            protocol: "openai-chat-completions",
            runtime: "llama-endpoint",
            endpoint: DEFAULT_LOCAL_ENDPOINT,
            fallback_endpoints: [],
            model_id: "qwen3.5-9b-vlm",
            api_key: "",
            capabilities: defaultCapabilities(true),
            parameters: defaultParameters({ temperature: 0.25, timeout: 180 }),
            ...defaultLocalValues()
        },
        {
            id: "local-qwen-once",
            display_name: "Local Qwen once",
            enabled: true,
            protocol: "openai-chat-completions",
            runtime: "llama-once",
            endpoint: DEFAULT_LOCAL_ENDPOINT,
            fallback_endpoints: [],
            model_id: "qwen3.5-9b-vlm",
            api_key: "",
            capabilities: defaultCapabilities(true),
            parameters: defaultParameters({ temperature: 0.25, timeout: 180 }),
            ...defaultLocalValues({
                model_path: DEFAULT_MODEL_PATH,
                mmproj_path: DEFAULT_MMPROJ_PATH,
                llama_server_path: DEFAULT_SERVER_PATH
            })
        }
    ];

    function stringValue(value, fallback) {
        return value === undefined || value === null ? String(fallback || "") : String(value);
    }

    function finiteNumber(value, fallback, minimum, maximum) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.min(maximum, Math.max(minimum, number));
    }

    function booleanValue(value, fallback) {
        if (typeof value === "boolean") return value;
        if (value === undefined || value === null || value === "") return fallback;
        return ["1", "true", "yes", "on", "enabled"].includes(String(value).trim().toLowerCase());
    }

    function reasoningValue(value, fallback) {
        const normalized = String(value || "").trim().toLowerCase();
        return ["low", "high", "max"].includes(normalized) ? normalized : fallback;
    }

    function isHttpEndpoint(value) {
        try {
            const parsed = new URL(String(value || ""));
            return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.host);
        } catch (_error) {
            return false;
        }
    }

    function normalizeEndpointList(value) {
        const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [];
        const seen = new Set();
        return values.map(function (item) { return String(item || "").trim().replace(/\/+$/, ""); }).filter(function (item) {
            if (!item || seen.has(item)) return false;
            seen.add(item);
            return true;
        });
    }

    function normalizeProfileId(value, fallback) {
        const cleaned = String(value || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
        return cleaned || fallback;
    }

    function normalizeModelProfile(profile, fallback) {
        const source = profile && typeof profile === "object" && !Array.isArray(profile) ? profile : {};
        const base = fallback && typeof fallback === "object" ? fallback : DEFAULT_PROFILES[0];
        const capabilities = source.capabilities && typeof source.capabilities === "object" ? source.capabilities : {};
        const parameters = source.parameters && typeof source.parameters === "object" ? source.parameters : {};
        const baseCapabilities = base.capabilities || defaultCapabilities(false);
        const baseParameters = base.parameters || defaultParameters();
        const baseLocal = defaultLocalValues(base);
        const sourceDisplayName = source.display_name === undefined ? source.name : source.display_name;
        const sourceModelId = source.model_id === undefined ? source.model : source.model_id;
        const baseDisplayName = base.display_name === undefined ? base.name : base.display_name;
        const baseModelId = base.model_id === undefined ? base.model : base.model_id;
        return {
            id: normalizeProfileId(source.id, normalizeProfileId(base.id, "profile")),
            display_name: stringValue(sourceDisplayName, baseDisplayName || "Model profile").trim() || "Model profile",
            enabled: booleanValue(source.enabled, base.enabled !== false),
            protocol: stringValue(source.protocol, base.protocol || "openai-chat-completions").trim() || "openai-chat-completions",
            runtime: stringValue(source.runtime, base.runtime || "remote-http").trim() || "remote-http",
            endpoint: stringValue(source.endpoint, base.endpoint).trim().replace(/\/+$/, ""),
            fallback_endpoints: normalizeEndpointList(source.fallback_endpoints === undefined ? base.fallback_endpoints : source.fallback_endpoints),
            model_id: stringValue(sourceModelId, baseModelId).trim(),
            api_key: stringValue(source.api_key, base.api_key),
            capabilities: {
                tools: booleanValue(capabilities.tools, baseCapabilities.tools !== false),
                vision: booleanValue(capabilities.vision, Boolean(baseCapabilities.vision)),
                streaming: booleanValue(capabilities.streaming, baseCapabilities.streaming !== false),
                reasoning: booleanValue(capabilities.reasoning, baseCapabilities.reasoning !== false)
            },
            parameters: {
                temperature: finiteNumber(parameters.temperature, baseParameters.temperature, 0, 2),
                top_p: finiteNumber(parameters.top_p, baseParameters.top_p, 0, 1),
                max_tokens: Math.round(finiteNumber(parameters.max_tokens, baseParameters.max_tokens, 1, 1048576)),
                reasoning_effort: reasoningValue(parameters.reasoning_effort, baseParameters.reasoning_effort),
                timeout: Math.round(finiteNumber(parameters.timeout, baseParameters.timeout, 1, 3600)),
                sanitize_sensitive: booleanValue(parameters.sanitize_sensitive, baseParameters.sanitize_sensitive !== false),
                teacher_mode: stringValue(parameters.teacher_mode, baseParameters.teacher_mode).trim() || "qwen-redact"
            },
            model_path: stringValue(source.model_path, baseLocal.model_path),
            mmproj_path: stringValue(source.mmproj_path, baseLocal.mmproj_path),
            llama_server_path: stringValue(source.llama_server_path, baseLocal.llama_server_path),
            n_ctx: Math.round(finiteNumber(source.n_ctx, baseLocal.n_ctx, 1024, 1048576)),
            n_gpu_layers: Math.round(finiteNumber(source.n_gpu_layers, baseLocal.n_gpu_layers, -1, 10000)),
            thinking: booleanValue(source.thinking, Boolean(baseLocal.thinking))
        };
    }

    function createDefaultProfileState() {
        return {
            version: PROFILE_SCHEMA_VERSION,
            active_profile_id: "moyuu-gemini",
            teacher_profile_id: "moyuu-gemini",
            profiles: deepCloneProfileData(DEFAULT_PROFILES)
        };
    }

    function normalizeProfileState(value) {
        const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
        const sourceProfiles = Array.isArray(source.profiles) && source.profiles.length ? source.profiles : DEFAULT_PROFILES;
        const seen = new Set();
        const hasCanonicalGrok = sourceProfiles.some(function (profile) { return profile && profile.id === "grok"; });
        const profiles = sourceProfiles.map(function (profile, index) {
            const normalized = normalizeModelProfile(profile, DEFAULT_PROFILES[index] || DEFAULT_PROFILES[0]);
            if (!hasCanonicalGrok && normalized.id === "legacy-secondary" && /^grok(?:[-_.]|$)/i.test(normalized.model_id)) {
                normalized.id = "grok";
                if (normalized.display_name === "Migrated secondary model") normalized.display_name = "Grok";
            }
            let id = normalized.id;
            let suffix = 2;
            while (seen.has(id)) {
                id = `${normalized.id}-${suffix}`;
                suffix += 1;
            }
            normalized.id = id;
            seen.add(id);
            return normalized;
        });
        if (!profiles.some(function (profile) { return profile.id === "grok"; })) {
            profiles.splice(Math.min(1, profiles.length), 0, deepCloneProfileData(DEFAULT_PROFILES[1]));
        }
        if (!profiles.some(function (profile) { return profile.enabled; })) profiles[0].enabled = true;
        const enabledIds = profiles.filter(function (profile) { return profile.enabled; }).map(function (profile) { return profile.id; });
        const remapGrokId = function (id) {
            return id === "legacy-secondary" && profiles.some(function (profile) { return profile.id === "grok"; }) ? "grok" : id;
        };
        const requestedActive = remapGrokId(String(source.active_profile_id || ""));
        const activeId = enabledIds.includes(requestedActive) ? requestedActive : enabledIds[0];
        const requestedTeacher = remapGrokId(String(source.teacher_profile_id || ""));
        const teacherId = enabledIds.includes(requestedTeacher) ? requestedTeacher : activeId;
        return { version: PROFILE_SCHEMA_VERSION, active_profile_id: activeId, teacher_profile_id: teacherId, profiles: profiles };
    }

    function modelProfileValidationErrors(profile) {
        const errors = [];
        if (!profile || typeof profile !== "object" || Array.isArray(profile)) return ["profile must be an object"];
        if (!String(profile.id || "").trim()) errors.push("profile id is required");
        if (!String(profile.display_name || "").trim()) errors.push("profile display_name is required");
        if (!String(profile.protocol || "").trim()) errors.push("profile protocol is required");
        else if (!["gemini-native", "openai-chat-completions"].includes(profile.protocol)) errors.push("profile protocol is unsupported");
        if (!String(profile.runtime || "").trim()) errors.push("profile runtime is required");
        else if (!["remote-http", "llama-endpoint", "llama-once"].includes(profile.runtime)) errors.push("profile runtime is unsupported");
        if (["llama-endpoint", "llama-once"].includes(profile.runtime) && profile.protocol !== "openai-chat-completions") {
            errors.push("local llama runtimes require the openai-chat-completions protocol");
        }
        if (!String(profile.model_id || "").trim()) errors.push("profile model_id is required");
        if (["remote-http", "llama-endpoint"].includes(profile.runtime) && !String(profile.endpoint || "").trim()) errors.push("profile endpoint is required");
        else if (profile.endpoint && !isHttpEndpoint(profile.endpoint)) errors.push("profile endpoint must be an HTTP URL");
        if (profile.runtime === "llama-once" && !String(profile.model_path || "").trim()) errors.push("model_path is required for llama-once");
        if (!Array.isArray(profile.fallback_endpoints)) errors.push("fallback_endpoints must be an array");
        else if (profile.fallback_endpoints.some(function (endpoint) { return !isHttpEndpoint(endpoint); })) errors.push("fallback endpoints must be HTTP URLs");
        if (!profile.capabilities || typeof profile.capabilities !== "object") errors.push("capabilities are required");
        if (!profile.parameters || typeof profile.parameters !== "object") errors.push("parameters are required");
        if (!Number.isInteger(profile.n_ctx)) errors.push("n_ctx must be an integer");
        if (!Number.isInteger(profile.n_gpu_layers)) errors.push("n_gpu_layers must be an integer");
        if (typeof profile.thinking !== "boolean") errors.push("thinking must be a boolean");
        return errors;
    }

    function profileStateValidationErrors(state) {
        const errors = [];
        if (!state || typeof state !== "object" || Array.isArray(state)) return ["profile state must be an object"];
        if (state.version !== PROFILE_SCHEMA_VERSION) errors.push("profile state version must be 2");
        if (!Array.isArray(state.profiles) || !state.profiles.length) return errors.concat("at least one profile is required");
        const ids = new Set();
        state.profiles.forEach(function (profile) {
            errors.push(...modelProfileValidationErrors(profile));
            if (ids.has(profile.id)) errors.push(`duplicate profile id: ${profile.id}`);
            ids.add(profile.id);
        });
        const enabledIds = state.profiles.filter(function (profile) { return profile.enabled === true; }).map(function (profile) { return profile.id; });
        if (!enabledIds.length) errors.push("at least one enabled profile is required");
        if (!enabledIds.includes(state.active_profile_id)) errors.push("active profile must be enabled");
        if (!enabledIds.includes(state.teacher_profile_id)) errors.push("teacher profile must be enabled");
        return errors;
    }

    function validateModelProfile(profile) {
        return modelProfileValidationErrors(profile).length === 0;
    }

    function validateProfileState(state) {
        return profileStateValidationErrors(state).length === 0;
    }

    function serializeProfileState(state) {
        const normalized = normalizeProfileState(state);
        const errors = profileStateValidationErrors(normalized);
        if (errors.length) throw new TypeError(errors.join("; "));
        return JSON.stringify(normalized);
    }

    function deserializeProfileState(serialized) {
        const parsed = JSON.parse(String(serialized));
        if (!parsed || parsed.version !== PROFILE_SCHEMA_VERSION || !Array.isArray(parsed.profiles) || !parsed.profiles.length) {
            throw new TypeError("invalid version 2 profile state");
        }
        const normalized = normalizeProfileState(parsed);
        const errors = profileStateValidationErrors(normalized);
        if (errors.length) throw new TypeError(errors.join("; "));
        return normalized;
    }

    function generateProfileId(profiles) {
        const existing = new Set((profiles || []).map(function (profile) { return profile.id; }));
        let id;
        do {
            generatedIdCounter += 1;
            const random = Math.random().toString(36).slice(2, 9);
            id = `profile-${Date.now().toString(36)}-${generatedIdCounter.toString(36)}-${random}`;
        } while (existing.has(id));
        return id;
    }

    function legacyBoolean(legacy, name, fallback) {
        return booleanValue(legacy[name], fallback);
    }

    function legacyNumber(legacy, name, fallback) {
        return finiteNumber(legacy[name], fallback, -1000000, 1000000);
    }

    function legacyApiKey(legacy, backend) {
        if (backend === "moyuu") return stringValue(legacy.api_key_moyuu, "");
        if (backend === "deepseek") return stringValue(legacy.api_key_deepseek, "");
        if (backend === "local-lmcpp" || backend === "local-qwen-once") return "";
        return stringValue(legacy.api_key_openai, "");
    }

    function inferLegacyTransport(backend) {
        if (backend === "moyuu") return { protocol: "gemini-native", runtime: "remote-http" };
        if (backend === "local-lmcpp") return { protocol: "openai-chat-completions", runtime: "llama-endpoint" };
        if (backend === "local-qwen-once") return { protocol: "openai-chat-completions", runtime: "llama-once" };
        return { protocol: "openai-chat-completions", runtime: "remote-http" };
    }

    function applyLegacyCommon(profile, legacy, localProfile) {
        const result = deepCloneProfileData(profile);
        result.parameters.reasoning_effort = stringValue(legacy.reasoning_effort, result.parameters.reasoning_effort);
        result.parameters.max_tokens = legacyNumber(legacy, localProfile ? "local_max_tokens" : "max_tokens", result.parameters.max_tokens);
        if (localProfile) {
            result.parameters.temperature = legacyNumber(legacy, "local_temperature", result.parameters.temperature);
            result.parameters.top_p = legacyNumber(legacy, "local_top_p", result.parameters.top_p);
            result.parameters.timeout = legacyNumber(legacy, "local_timeout", result.parameters.timeout);
        }
        result.parameters.sanitize_sensitive = legacyBoolean(legacy, "sanitize_sensitive", result.parameters.sanitize_sensitive);
        result.parameters.teacher_mode = stringValue(legacy.teacher_mode, result.parameters.teacher_mode);
        result.model_path = stringValue(legacy.vision_model_path, result.model_path);
        result.mmproj_path = stringValue(legacy.vision_mmproj_path, result.mmproj_path);
        result.llama_server_path = stringValue(legacy.llama_server_path, result.llama_server_path);
        result.n_ctx = legacyNumber(legacy, "n_ctx", result.n_ctx);
        result.n_gpu_layers = legacyNumber(legacy, "local_n_gpu_layers", result.n_gpu_layers);
        result.thinking = legacyBoolean(legacy, localProfile ? "local_text_thinking" : "vision_thinking", result.thinking);
        return normalizeModelProfile(result, profile);
    }

    function migrationProfileForBackend(state, legacy, backend, role) {
        const profiles = state.profiles;
        const secondaryModel = stringValue(legacy.secondary_model, legacy.fallback_model).trim();
        const grokSecondary = role === "secondary" && backend === "openai" && (!secondaryModel || /^grok(?:[-_.]|$)/i.test(secondaryModel));
        const standardId = grokSecondary ? "grok" : backend === "moyuu" ? "moyuu-gemini" : backend === "deepseek" ? "deepseek" : backend === "local-lmcpp" ? "local-llama-endpoint" : backend === "local-qwen-once" ? "local-qwen-once" : "";
        let profile = profiles.find(function (item) { return item.id === standardId; });
        if (!profile) {
            profile = normalizeModelProfile({
                id: `legacy-${role}`,
                display_name: role === "secondary" ? "Migrated secondary model" : "Migrated remote model",
                enabled: true
            }, DEFAULT_PROFILES[1]);
            profiles.push(profile);
        }
        return profile;
    }

    function configureLegacyProfile(profile, legacy, backend, role) {
        const secondary = role === "secondary";
        const transport = inferLegacyTransport(backend);
        const endpoint = secondary
            ? stringValue(legacy.secondary_endpoint, stringValue(legacy.fallback_model_endpoint, legacy.endpoint))
            : backend === "local-lmcpp" ? stringValue(legacy.local_endpoint, DEFAULT_LOCAL_ENDPOINT)
                : backend === "local-qwen-once" ? stringValue(legacy.vision_endpoint, DEFAULT_LOCAL_ENDPOINT)
                    : stringValue(legacy.endpoint, profile.endpoint);
        const model = secondary
            ? stringValue(legacy.secondary_model, stringValue(legacy.fallback_model, profile.model_id))
            : backend === "local-lmcpp" ? stringValue(legacy.local_model, profile.model_id)
                : backend === "local-qwen-once" ? stringValue(legacy.vision_model, stringValue(legacy.local_model, profile.model_id))
                    : stringValue(legacy.model, profile.model_id);
        const configured = Object.assign(deepCloneProfileData(profile), transport, {
            endpoint: endpoint,
            model_id: model,
            api_key: legacyApiKey(legacy, backend)
        });
        if (secondary && backend === "openai" && /(^|\.)moyuu\.cc$/i.test((function () {
            try { return new URL(endpoint).hostname; } catch (_error) { return ""; }
        })())) configured.api_key = legacyApiKey(legacy, "moyuu") || configured.api_key;
        if (backend === "moyuu") configured.fallback_endpoints = normalizeEndpointList(legacy.fallback_endpoint || profile.fallback_endpoints);
        return applyLegacyCommon(configured, legacy, backend === "local-lmcpp" || backend === "local-qwen-once");
    }

    function migrateLegacyAssistantProfiles(legacyValues) {
        const legacy = legacyValues && typeof legacyValues === "object" ? legacyValues : {};
        const state = createDefaultProfileState();
        state.profiles = state.profiles.map(function (profile) {
            const keyBackend = profile.id === "moyuu-gemini" || profile.id === "grok" ? "moyuu" : profile.id === "deepseek" ? "deepseek" : profile.id === "local-llama-endpoint" ? "local-lmcpp" : "local-qwen-once";
            const withKey = deepCloneProfileData(profile);
            withKey.api_key = legacyApiKey(legacy, keyBackend);
            return applyLegacyCommon(withKey, legacy, keyBackend.startsWith("local-"));
        });

        const primaryBackend = stringValue(legacy.backend, "moyuu").trim() || "moyuu";
        const primary = migrationProfileForBackend(state, legacy, primaryBackend, "primary");
        const primaryIndex = state.profiles.indexOf(primary);
        state.profiles[primaryIndex] = configureLegacyProfile(primary, legacy, primaryBackend, "primary");

        let secondaryId = "";
        const hasSecondary = ["secondary_backend", "secondary_endpoint", "secondary_model", "fallback_backend", "fallback_model", "fallback_model_endpoint"].some(function (name) {
            return legacy[name] !== undefined && legacy[name] !== null && legacy[name] !== "";
        });
        if (hasSecondary) {
            const secondaryBackend = stringValue(legacy.secondary_backend, stringValue(legacy.fallback_backend, "openai")).trim() || "openai";
            let secondary = migrationProfileForBackend(state, legacy, secondaryBackend, "secondary");
            if (secondary.id === state.profiles[primaryIndex].id && secondaryBackend === primaryBackend) {
                secondary = normalizeModelProfile(Object.assign({}, secondary, { id: "legacy-secondary", display_name: "Migrated secondary model" }), secondary);
                state.profiles.push(secondary);
            }
            const secondaryIndex = state.profiles.indexOf(secondary);
            state.profiles[secondaryIndex] = configureLegacyProfile(secondary, legacy, secondaryBackend, "secondary");
            secondaryId = state.profiles[secondaryIndex].id;
        }

        const route = stringValue(legacy.chat_model_route, "remote");
        if (route === "local") state.active_profile_id = "local-qwen-once";
        else if ((route === "secondary" || route === "fallback") && secondaryId) state.active_profile_id = secondaryId;
        else state.active_profile_id = state.profiles[primaryIndex].id;
        state.teacher_profile_id = "moyuu-gemini";
        return normalizeProfileState(state);
    }

    function readLegacyValues(storage) {
        const values = {};
        let found = false;
        LEGACY_SETTING_NAMES.forEach(function (name) {
            const value = storage.getItem(LEGACY_PREFIX + name);
            if (value !== null) {
                values[name] = value;
                found = true;
            }
        });
        return { found: found, values: values };
    }

    function mergeProfilePatch(profile, patch) {
        const source = patch && typeof patch === "object" ? patch : {};
        const merged = Object.assign({}, profile, source);
        merged.capabilities = Object.assign({}, profile.capabilities, source.capabilities || {});
        merged.parameters = Object.assign({}, profile.parameters, source.parameters || {});
        return merged;
    }

    function createProfileStore(storage) {
        if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
            throw new TypeError("Profile store requires localStorage-compatible storage");
        }

        function save(state) {
            const normalized = normalizeProfileState(state);
            storage.setItem(PROFILE_STORAGE_KEY, serializeProfileState(normalized));
            return deepCloneProfileData(normalized);
        }

        function load() {
            const serialized = storage.getItem(PROFILE_STORAGE_KEY);
            if (serialized !== null) {
                try {
                    return deepCloneProfileData(deserializeProfileState(serialized));
                } catch (_error) {
                    return createDefaultProfileState();
                }
            }
            const legacy = readLegacyValues(storage);
            return save(legacy.found ? migrateLegacyAssistantProfiles(legacy.values) : createDefaultProfileState());
        }

        function current() {
            const state = load();
            return deepCloneProfileData(state.profiles.find(function (profile) { return profile.id === state.active_profile_id; }));
        }

        function teacher() {
            const state = load();
            return deepCloneProfileData(state.profiles.find(function (profile) { return profile.id === state.teacher_profile_id; }));
        }

        function add(profile) {
            const state = load();
            const source = Object.assign({}, profile || {});
            source.id = source.id ? normalizeProfileId(source.id, "") : generateProfileId(state.profiles);
            if (!source.id || state.profiles.some(function (item) { return item.id === source.id; })) source.id = generateProfileId(state.profiles);
            const added = normalizeModelProfile(source, DEFAULT_PROFILES[0]);
            state.profiles.push(added);
            save(state);
            return deepCloneProfileData(added);
        }

        function duplicate(id) {
            const state = load();
            const source = state.profiles.find(function (profile) { return profile.id === id; });
            if (!source) throw new RangeError(`unknown profile: ${id}`);
            const copy = deepCloneProfileData(source);
            copy.id = generateProfileId(state.profiles);
            copy.display_name = `${source.display_name} copy`;
            state.profiles.push(copy);
            save(state);
            return deepCloneProfileData(copy);
        }

        function update(id, patch) {
            const state = load();
            const index = state.profiles.findIndex(function (profile) { return profile.id === id; });
            if (index < 0) throw new RangeError(`unknown profile: ${id}`);
            const candidate = mergeProfilePatch(state.profiles[index], patch);
            candidate.id = id;
            const updated = normalizeModelProfile(candidate, state.profiles[index]);
            if (!updated.enabled && state.profiles.filter(function (profile) { return profile.enabled && profile.id !== id; }).length === 0) {
                throw new RangeError("at least one enabled profile is required");
            }
            state.profiles[index] = updated;
            if (!updated.enabled) {
                const fallback = state.profiles.find(function (profile) { return profile.enabled; });
                if (state.active_profile_id === id) state.active_profile_id = fallback.id;
                if (state.teacher_profile_id === id) state.teacher_profile_id = fallback.id;
            }
            save(state);
            return deepCloneProfileData(updated);
        }

        function remove(id) {
            const state = load();
            const profile = state.profiles.find(function (item) { return item.id === id; });
            if (!profile) throw new RangeError(`unknown profile: ${id}`);
            if (profile.enabled && state.profiles.filter(function (item) { return item.enabled; }).length === 1) {
                throw new RangeError("at least one enabled profile is required");
            }
            state.profiles = state.profiles.filter(function (item) { return item.id !== id; });
            const fallback = state.profiles.find(function (item) { return item.enabled; });
            if (state.active_profile_id === id) state.active_profile_id = fallback.id;
            if (state.teacher_profile_id === id) state.teacher_profile_id = fallback.id;
            save(state);
            return deepCloneProfileData(profile);
        }

        function setActive(id) {
            const state = load();
            const profile = state.profiles.find(function (item) { return item.id === id && item.enabled; });
            if (!profile) throw new RangeError(`unknown or disabled profile: ${id}`);
            state.active_profile_id = id;
            save(state);
            return deepCloneProfileData(profile);
        }

        function setTeacher(id) {
            const state = load();
            const profile = state.profiles.find(function (item) { return item.id === id && item.enabled; });
            if (!profile) throw new RangeError(`unknown or disabled profile: ${id}`);
            state.teacher_profile_id = id;
            save(state);
            return deepCloneProfileData(profile);
        }

        function restoreDefaults() {
            return save(createDefaultProfileState());
        }

        function requestProjection(id) {
            const state = load();
            const selectedId = id || state.active_profile_id;
            const profile = state.profiles.find(function (item) { return item.id === selectedId && item.enabled; });
            if (!profile) throw new RangeError(`unknown or disabled profile: ${selectedId}`);
            return {
                profile_id: profile.id,
                protocol: profile.protocol,
                runtime: profile.runtime,
                endpoint: profile.endpoint,
                fallback_endpoints: deepCloneProfileData(profile.fallback_endpoints),
                model: profile.model_id,
                api_key: profile.api_key,
                capabilities: deepCloneProfileData(profile.capabilities),
                parameters: deepCloneProfileData(profile.parameters),
                model_path: profile.model_path,
                mmproj_path: profile.mmproj_path,
                llama_server_path: profile.llama_server_path,
                n_ctx: profile.n_ctx,
                n_gpu_layers: profile.n_gpu_layers,
                thinking: profile.thinking
            };
        }

        return {
            load: load,
            save: save,
            current: current,
            teacher: teacher,
            add: add,
            duplicate: duplicate,
            update: update,
            delete: remove,
            setActive: setActive,
            setTeacher: setTeacher,
            restoreDefaults: restoreDefaults,
            requestProjection: requestProjection
        };
    }

    const browserStorage = window.localStorage || (typeof localStorage !== "undefined" ? localStorage : null);
    const profileStore = browserStorage ? createProfileStore(browserStorage) : null;
    Object.assign(tools, {
        PROFILE_STORAGE_KEY: PROFILE_STORAGE_KEY,
        PROFILE_SCHEMA_VERSION: PROFILE_SCHEMA_VERSION,
        DEFAULT_MODEL_PROFILES: deepCloneProfileData(DEFAULT_PROFILES),
        LEGACY_ASSISTANT_PROFILE_KEYS: LEGACY_SETTING_NAMES.map(function (name) { return LEGACY_PREFIX + name; }),
        deepCloneProfileData: deepCloneProfileData,
        createDefaultProfileState: createDefaultProfileState,
        normalizeModelProfile: normalizeModelProfile,
        normalizeProfileState: normalizeProfileState,
        modelProfileValidationErrors: modelProfileValidationErrors,
        profileStateValidationErrors: profileStateValidationErrors,
        validateModelProfile: validateModelProfile,
        validateProfileState: validateProfileState,
        serializeProfileState: serializeProfileState,
        deserializeProfileState: deserializeProfileState,
        migrateLegacyAssistantProfiles: migrateLegacyAssistantProfiles,
        createProfileStore: createProfileStore,
        profileStore: profileStore,
        loadModelProfiles: profileStore ? profileStore.load : null,
        saveModelProfiles: profileStore ? profileStore.save : null,
        currentModelProfile: profileStore ? profileStore.current : null,
        teacherModelProfile: profileStore ? profileStore.teacher : null,
        addModelProfile: profileStore ? profileStore.add : null,
        duplicateModelProfile: profileStore ? profileStore.duplicate : null,
        updateModelProfile: profileStore ? profileStore.update : null,
        deleteModelProfile: profileStore ? profileStore.delete : null,
        setActiveModelProfile: profileStore ? profileStore.setActive : null,
        setTeacherModelProfile: profileStore ? profileStore.setTeacher : null,
        restoreDefaultModelProfiles: profileStore ? profileStore.restoreDefaults : null,
        projectModelProfileRequest: profileStore ? profileStore.requestProjection : null
    });
})();
