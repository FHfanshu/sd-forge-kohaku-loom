(function () {
    const tools = window.__SD_FORGE_NEO_PROMPT_AGENT__ = window.__SD_FORGE_NEO_PROMPT_AGENT__ || {};
    const DEFAULT_LOCALE = "en";
    const LOCALES = ["en", "zh-CN"];
    const LOCALE_STORAGE_KEY = "prompt_agent_locale";
    const LEGACY_LOCALE_STORAGE_KEYS = ["loom_assistant_locale", "kohaku_loom_locale", "loom_locale"];
    const messages = {
        en: {
            "assistant.attach": "Attach image",
            "assistant.clear": "Clear",
            "assistant.close": "Close",
            "assistant.empty.title": "Start from the current prompt",
            "assistant.input.placeholder": "Describe what you want to analyze, add, or change...",
            "assistant.launcher": "SD Forge Neo Prompt Agent",
            "assistant.read": "Read",
            "assistant.read_prompt": "Read the current prompt and WebUI style template. Briefly summarize the composition, trigger words, and spatial relationships they describe. If both are empty, say they are empty.",
            "assistant.rewind": "Edit and resend",
            "assistant.send": "Send",
            "assistant.settings": "Settings",
            "assistant.stop": "Stop",
            "assistant.title": "SD Forge Neo Prompt Agent",
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
            "settings.title": "SD Forge Neo Prompt Agent Settings",
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
    let legacyLocaleMigrationComplete = false;

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

    function migrateLegacyLocale() {
        if (legacyLocaleMigrationComplete) return null;
        legacyLocaleMigrationComplete = true;

        let canonicalValue = null;
        try {
            canonicalValue = localStorage.getItem(LOCALE_STORAGE_KEY);
        } catch (_error) { }
        const canonicalLocale = recognizedLocale(canonicalValue);
        let migratedLocale = canonicalLocale;
        if (!canonicalLocale && String(canonicalValue || "").trim().toLowerCase() !== "auto") {
            for (const key of LEGACY_LOCALE_STORAGE_KEYS) {
                try {
                    const locale = recognizedLocale(localStorage.getItem(key));
                    if (!migratedLocale && locale) migratedLocale = locale;
                } catch (_error) { }
            }
            if (migratedLocale) {
                try { localStorage.setItem(LOCALE_STORAGE_KEY, migratedLocale); } catch (_error) { }
            }
        }
        LEGACY_LOCALE_STORAGE_KEYS.forEach(function (key) {
            try { localStorage.removeItem(key); } catch (_error) { }
        });
        return migratedLocale;
    }

    function readManualLocale() {
        const migrated = migrateLegacyLocale();
        if (migrated) return migrated;
        try {
            const value = localStorage.getItem(LOCALE_STORAGE_KEY);
            if (String(value || "").trim().toLowerCase() === "auto") return null;
            return recognizedLocale(value);
        } catch (_error) {
            return null;
        }
    }

    function browserLocales() {
        if (typeof navigator === "undefined") return [];
        return navigator.languages?.length ? navigator.languages : [navigator.language];
    }

    function forgeLocale() {
        const fromHints = localeFromCandidates(forgeHints?.locale || forgeHints?.code);
        if (fromHints) return fromHints;
        return localeFromCandidates(tools.forgeLocale || tools.activeLocale);
    }

    function chooseLocale() {
        return readManualLocale() || forgeLocale() || localeFromCandidates(browserLocales()) || DEFAULT_LOCALE;
    }

    function emitLocaleChanged(reason) {
        tools.activeLocale = activeLocale;
        tools.forgeLocale = forgeLocale();
        if (typeof window.dispatchEvent !== "function" || typeof window.CustomEvent !== "function") return;
        window.dispatchEvent(new CustomEvent("prompt-agent:locale-changed", {
            detail: { locale: activeLocale, forge_locale: tools.forgeLocale || null, reason: reason || "runtime" }
        }));
    }

    function applyLocale(reason) {
        const next = chooseLocale();
        if (next !== activeLocale) {
            activeLocale = next;
            emitLocaleChanged(reason);
        } else {
            tools.activeLocale = activeLocale;
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
        metadataPromise = fetch("/prompt-agent/api/i18n/locale", { cache: "no-store" })
            .then(function (response) { return response.ok ? response.json() : null; })
            .then(function (data) {
                const parsed = parseLocaleMetadata(data);
                if (parsed) {
                    forgeHints = parsed;
                    tools.localeMetadata = parsed;
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
            return fetch(`/prompt-agent/api/i18n?locale=${encodeURIComponent(locale)}`, { cache: "no-store" })
                .then(function (response) { return response.ok ? response.json() : null; })
                .then(function (bundle) {
                    if (!bundle || !bundle.messages) return;
                    const selected = recognizedLocale(bundle.locale) || locale;
                    messages[selected] = Object.assign({}, messages[DEFAULT_LOCALE], bundle.messages);
                    tools.i18nVersions = tools.i18nVersions || {};
                    tools.i18nVersions[selected] = bundle.content_version || bundle.metadata?.content_version || "";
                });
        })).then(function () {
            applyLocale("bundles");
            tools.i18nReady = true;
            return messages;
        }).catch(function () {
            tools.i18nReady = true;
            return messages;
        });
        return bundlesPromise;
    }

    function loadI18nBundle(force) {
        if (!tools.i18nLoading || force) {
            tools.i18nLoading = Promise.all([probeLocaleMetadata(), preloadBundles(Boolean(force))])
                .finally(function () { tools.i18nLoading = null; });
        }
        return tools.i18nLoading;
    }

    function setLocale(value) {
        const raw = String(value || "").trim();
        const locale = recognizedLocale(raw);
        try {
            if (raw.toLowerCase() === "auto" || !locale) localStorage.removeItem(LOCALE_STORAGE_KEY);
            else localStorage.setItem(LOCALE_STORAGE_KEY, locale);
        } catch (_error) { }
        applyLocale("manual");
        return activeLocale;
    }

    function subscribeLocaleHints(listener) {
        if (typeof window.addEventListener !== "function") return function () { };
        const handler = function () { Promise.resolve(probeLocaleMetadata()).then(function () { listener(getLocaleHints()); }); };
        window.addEventListener("prompt-agent:locale-hints-changed", handler);
        window.addEventListener("prompt-agent:locale-changed", handler);
        window.addEventListener("prompt-agent:forge-locale-changed", handler);
        return function () {
            window.removeEventListener("prompt-agent:locale-hints-changed", handler);
            window.removeEventListener("prompt-agent:locale-changed", handler);
            window.removeEventListener("prompt-agent:forge-locale-changed", handler);
        };
    }

    function getLocaleHints() {
        return Object.assign({ locale: forgeLocale(), supported_locales: LOCALES.slice(), source: "forge-metadata" }, forgeHints || {});
    }

    Object.assign(tools, {
        LOCALE_STORAGE_KEY: LOCALE_STORAGE_KEY,
        LEGACY_LOCALE_STORAGE_KEYS: LEGACY_LOCALE_STORAGE_KEYS,
        migrateLegacyLocale: migrateLegacyLocale,
        messages: messages,
        locale: currentLocale,
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
        window.addEventListener("prompt-agent:locale-hints-changed", function () { probeLocaleMetadata(); });
        window.addEventListener("prompt-agent:forge-locale-changed", function () { probeLocaleMetadata(); });
    }
    applyLocale("bootstrap");
})();
