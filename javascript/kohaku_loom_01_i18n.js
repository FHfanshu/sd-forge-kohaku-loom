(function () {
    const tools = window.kohakuLoom = window.kohakuLoom || {};
    const DEFAULT_LOCALE = "en";
    const LOCALES = ["en", "zh-CN"];
    const LOCALE_STORAGE_KEYS = ["loom_assistant_locale", "kohaku_loom_locale", "loom_locale"];
    const messages = {
        en: {
            "assistant.attach": "Attach image",
            "assistant.clear": "Clear",
            "assistant.close": "Close",
            "assistant.empty.title": "Start from the current prompt",
            "assistant.input.placeholder": "Describe what you want to analyze, add, or change...",
            "assistant.launcher": "LLM Assistant",
            "assistant.read": "Read",
            "assistant.read_prompt": "Read the current prompt and WebUI style template. Briefly summarize the composition, trigger words, and spatial relationships they describe. If both are empty, say they are empty.",
            "assistant.rewind": "Edit and resend",
            "assistant.send": "Send",
            "assistant.settings": "Settings",
            "assistant.stop": "Stop",
            "assistant.title": "LLM Prompt Assistant",
            "assistant.role.user": "You",
            "assistant.role.assistant": "Assistant",
            "assistant.role.error": "Error",
            "common.off": "Off",
            "common.on": "On",
            "settings.model": "Model",
            "settings.reasoning_effort": "Reasoning effort",
            "settings.reasoning_low": "Low",
            "settings.reasoning_high": "High",
            "settings.reasoning_max": "Max",
            "settings.title": "Assistant Settings",
            "profiles.close": "Close",
            "profiles.status.saved": "Saved",
            "profiles.status.invalid": "Check this value and try again.",
            "profiles.api_key.show": "Show",
            "profiles.api_key.hide": "Hide",
            "profiles.test": "Test connection",
            "notifications.bridge_unavailable": "The Svelte host bridge is unavailable.",
            "notifications.forge_unavailable": "The Forge application is not ready.",
            "notifications.error": "Operation failed",
        },
    };
    let activeLocale = DEFAULT_LOCALE;
    let forgeHints = null;
    let metadataPromise = null;
    let bundlesPromise = null;

    function recognizedLocale(value) {
        const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
        if (raw.startsWith("zh") || raw === "cn" || raw === "中文" || raw === "chinese") return "zh-CN";
        if (raw.startsWith("en") || raw === "english" || raw === "eng") return "en";
        return null;
    }

    function normalizeLocale(value) {
        return recognizedLocale(value) || DEFAULT_LOCALE;
    }

    function localeFromCandidates(value) {
        const candidates = Array.isArray(value) ? value : [value];
        for (const candidate of candidates) {
            const locale = recognizedLocale(candidate);
            if (locale) return locale;
        }
        return null;
    }

    function readManualLocale() {
        for (const key of LOCALE_STORAGE_KEYS) {
            try {
                const value = localStorage.getItem(key);
                if (String(value || "").trim().toLowerCase() === "auto") return null;
                const locale = recognizedLocale(value);
                if (locale) return locale;
            } catch (_error) { }
        }
        return null;
    }

    function browserLocales() {
        if (typeof navigator === "undefined") return [];
        return navigator.languages?.length ? navigator.languages : [navigator.language];
    }

    function forgeLocale() {
        const fromHints = localeFromCandidates(forgeHints?.locale || forgeHints?.code);
        if (fromHints) return fromHints;
        return localeFromCandidates(tools.forgeLocale || tools.loomForgeLocale || tools.loomActiveLocale);
    }

    function chooseLocale() {
        return readManualLocale() || forgeLocale() || localeFromCandidates(browserLocales()) || DEFAULT_LOCALE;
    }

    function emitLocaleChanged(reason) {
        tools.loomActiveLocale = activeLocale;
        tools.forgeLocale = forgeLocale();
        if (typeof window.dispatchEvent !== "function" || typeof window.CustomEvent !== "function") return;
        window.dispatchEvent(new CustomEvent("kohaku-loom:locale-changed", {
            detail: { locale: activeLocale, forge_locale: tools.forgeLocale || null, reason: reason || "runtime" }
        }));
    }

    function applyLocale(reason) {
        const next = chooseLocale();
        if (next !== activeLocale) {
            activeLocale = next;
            emitLocaleChanged(reason);
        } else {
            tools.loomActiveLocale = activeLocale;
        }
        return activeLocale;
    }

    function currentLocale() {
        return activeLocale;
    }

    function tr(key) {
        return messages[activeLocale]?.[key] || messages[DEFAULT_LOCALE]?.[key] || key;
    }

    function parseLocaleMetadata(value) {
        if (!value || typeof value !== "object") return null;
        const locale = recognizedLocale(value.locale || value.metadata?.code);
        return locale ? Object.assign({}, value, { locale: locale }) : null;
    }

    async function probeLocaleMetadata() {
        if (metadataPromise) return metadataPromise;
        metadataPromise = fetch("/kohaku-loom/i18n/locale", { cache: "no-store" })
            .then(function (response) { return response.ok ? response.json() : null; })
            .then(function (data) {
                const parsed = parseLocaleMetadata(data);
                if (parsed) {
                    forgeHints = parsed;
                    tools.loomLocaleMetadata = parsed;
                    tools.forgeLocale = parsed.locale;
                    applyLocale("metadata");
                }
                return parsed;
            })
            .catch(function () { return null; })
            .finally(function () { metadataPromise = null; });
        return metadataPromise;
    }

    async function preloadBundles(force) {
        if (bundlesPromise && !force) return bundlesPromise;
        bundlesPromise = Promise.allSettled(LOCALES.map(function (locale) {
            return fetch(`/kohaku-loom/i18n?locale=${encodeURIComponent(locale)}`, { cache: "no-store" })
                .then(function (response) { return response.ok ? response.json() : null; })
                .then(function (bundle) {
                    if (!bundle || !bundle.messages) return;
                    const selected = recognizedLocale(bundle.locale) || locale;
                    messages[selected] = Object.assign({}, messages[DEFAULT_LOCALE], bundle.messages);
                    tools.loomI18nVersions = tools.loomI18nVersions || {};
                    tools.loomI18nVersions[selected] = bundle.content_version || bundle.metadata?.content_version || "";
                });
        })).then(function () {
            applyLocale("bundles");
            tools.loomI18nReady = true;
            return messages;
        }).catch(function () {
            tools.loomI18nReady = true;
            return messages;
        });
        return bundlesPromise;
    }

    function loadI18nBundle(force) {
        if (!tools.loomI18nLoading || force) {
            tools.loomI18nLoading = Promise.all([probeLocaleMetadata(), preloadBundles(Boolean(force))])
                .finally(function () { tools.loomI18nLoading = null; });
        }
        return tools.loomI18nLoading;
    }

    function setLocale(value) {
        const raw = String(value || "").trim();
        const locale = recognizedLocale(raw);
        LOCALE_STORAGE_KEYS.forEach(function (key) {
            try {
                if (raw.toLowerCase() === "auto" || !locale) localStorage.removeItem(key);
                else localStorage.setItem(key, locale);
            } catch (_error) { }
        });
        applyLocale("manual");
        return activeLocale;
    }

    function subscribeLocaleHints(listener) {
        if (typeof window.addEventListener !== "function") return function () { };
        const handler = function () { Promise.resolve(probeLocaleMetadata()).then(function () { listener(getLocaleHints()); }); };
        window.addEventListener("kohaku-loom:locale-hints-changed", handler);
        window.addEventListener("forge-locale-changed", handler);
        return function () {
            window.removeEventListener("kohaku-loom:locale-hints-changed", handler);
            window.removeEventListener("forge-locale-changed", handler);
        };
    }

    function getLocaleHints() {
        return Object.assign({ locale: forgeLocale(), supported_locales: LOCALES.slice(), source: "forge-metadata" }, forgeHints || {});
    }

    Object.assign(tools, {
        LOCALE_STORAGE_KEYS: LOCALE_STORAGE_KEYS,
        loomMessages: messages,
        loomLocale: currentLocale,
        normalizeLocale: normalizeLocale,
        recognizedLocale: recognizedLocale,
        tr: tr,
        setLocale: setLocale,
        loadI18nBundle: loadI18nBundle,
        preloadI18nBundles: preloadBundles,
        probeLocaleMetadata: probeLocaleMetadata,
        getLocaleHints: getLocaleHints,
        subscribeLocaleHints: subscribeLocaleHints,
    });

    if (typeof window.addEventListener === "function") {
        window.addEventListener("kohaku-loom:locale-hints-changed", function () { probeLocaleMetadata(); });
        window.addEventListener("forge-locale-changed", function () { probeLocaleMetadata(); });
    }
    applyLocale("bootstrap");
    loadI18nBundle();
})();
