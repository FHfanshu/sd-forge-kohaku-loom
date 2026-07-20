import { createStore } from "./store";
import type { LocaleCode, PythonTranslationBundle } from "../contracts";
import { promptAgentNamespace } from "../bridge";
import {
  PROMPT_AGENT_STORAGE_KEYS,
  LEGACY_STORAGE_KEYS,
  readMigratedStorageValue,
  removePromptAgentStorageValue,
  writePromptAgentStorageValue,
} from "../storage-migrations";
import {
  metadataForBundle,
  preloadPythonBundles,
  probePythonLocaleMetadata,
  recognizedLocale,
  selectLocale,
  translate,
  type PreloadedBundles,
  type RuntimeLocaleMetadata,
} from "../i18n/runtime";

const MANUAL_LOCALE_STORAGE_KEY = PROMPT_AGENT_STORAGE_KEYS.locale;
let hostLocaleUnsubscribe: (() => void) | null = null;

export interface I18nStore {
  locale: LocaleCode;
  manualLocale: LocaleCode | null;
  forgeLocale: LocaleCode | null;
  browserLanguages: readonly string[];
  bundles: Partial<Record<LocaleCode, PythonTranslationBundle>>;
  metadata: Partial<Record<LocaleCode, RuntimeLocaleMetadata>>;
  loading: boolean;
  error: string | null;
  setLocale(locale: unknown): void;
  clearManualLocale(): void;
  setForgeLocale(locale: unknown): void;
  setBrowserLanguages(languages: readonly unknown[]): void;
  setBundles(preloaded: PreloadedBundles): void;
  applyHostLocaleHints(hints: unknown): void;
  subscribeToHostLocaleHints(): () => void;
  preload(fetchImpl?: typeof fetch, signal?: AbortSignal): Promise<void>;
  t(key: string): string;
  reset(): void;
}

function readBrowserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? [...navigator.languages] : navigator.language ? [navigator.language] : [];
}

function readForgeLocale(): unknown {
  if (typeof window === "undefined") return undefined;
  const namespace = promptAgentNamespace(window);
  const host = readHostLocaleApi(namespace?.hostApi);
  return host?.getLocaleHints?.() ?? namespace?.forgeLocale ?? namespace?.activeLocale;
}

interface HostLocaleApi {
  getLocaleHints?: () => unknown;
  subscribeLocaleHints?: (listener: (hints: unknown) => void) => () => void;
}

function readHostLocaleApi(value: unknown): HostLocaleApi | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as HostLocaleApi;
  return typeof candidate.getLocaleHints === "function" || typeof candidate.subscribeLocaleHints === "function"
    ? candidate
    : null;
}

function readManualLocale(): LocaleCode | null {
  const storage = getStorage();
  if (!storage) return null;
  const raw = readMigratedStorageValue(storage, MANUAL_LOCALE_STORAGE_KEY, LEGACY_STORAGE_KEYS.locale);
  if (!raw || raw.toLowerCase() === "auto") return null;
  return recognizedLocale(raw);
}

function getStorage(): Storage | null {
  try {
    const storage = typeof window !== "undefined" ? window.localStorage : undefined;
    return storage && typeof storage.getItem === "function" && typeof storage.setItem === "function" && typeof storage.removeItem === "function"
      ? storage
      : null;
  } catch {
    return null;
  }
}

function chooseLocale(
  manualLocale: LocaleCode | null,
  forgeLocale: LocaleCode | null,
  browserLanguages: readonly string[],
): LocaleCode {
  return selectLocale({ manual: manualLocale, forge: forgeLocale, navigatorLanguages: browserLanguages });
}

const initialBrowserLanguages = readBrowserLanguages();
const initialManualLocale = readManualLocale();
const initialForgeLocale = recognizedLocale(readForgeLocale());

export const useI18nStore = createStore<I18nStore>((set, get) => ({
  locale: chooseLocale(initialManualLocale, initialForgeLocale, initialBrowserLanguages),
  manualLocale: initialManualLocale,
  forgeLocale: initialForgeLocale,
  browserLanguages: initialBrowserLanguages,
  bundles: {},
  metadata: {},
  loading: false,
  error: null,
  setLocale(locale) {
    const manualLocale = recognizedLocale(locale);
    const state = get();
    const storage = getStorage();
    if (storage) {
      if (manualLocale) writePromptAgentStorageValue(storage, MANUAL_LOCALE_STORAGE_KEY, LEGACY_STORAGE_KEYS.locale, manualLocale);
      else removePromptAgentStorageValue(storage, MANUAL_LOCALE_STORAGE_KEY, LEGACY_STORAGE_KEYS.locale);
    }
    set({ manualLocale, locale: chooseLocale(manualLocale, state.forgeLocale, state.browserLanguages) });
  },
  clearManualLocale() {
    const state = get();
    const storage = getStorage();
    if (storage) removePromptAgentStorageValue(storage, MANUAL_LOCALE_STORAGE_KEY, LEGACY_STORAGE_KEYS.locale);
    set({ manualLocale: null, locale: chooseLocale(null, state.forgeLocale, state.browserLanguages) });
  },
  setForgeLocale(locale) {
    const forgeLocale = recognizedLocale(locale);
    const state = get();
    set({ forgeLocale, locale: chooseLocale(state.manualLocale, forgeLocale, state.browserLanguages) });
  },
  setBrowserLanguages(languages) {
    const browserLanguages = languages.map(String);
    const state = get();
    set({ browserLanguages, locale: chooseLocale(state.manualLocale, state.forgeLocale, browserLanguages) });
  },
  setBundles(preloaded) {
    set({ bundles: preloaded.bundles, metadata: preloaded.metadata, error: null });
  },
  applyHostLocaleHints(hints) {
    get().setForgeLocale(hints && typeof hints === "object" ? (hints as { locale?: unknown }).locale : hints);
  },
  subscribeToHostLocaleHints() {
    if (hostLocaleUnsubscribe) return hostLocaleUnsubscribe;
    if (typeof window === "undefined") return () => undefined;
    const host = readHostLocaleApi(promptAgentNamespace(window)?.hostApi);
    if (!host || typeof host.subscribeLocaleHints !== "function") return () => undefined;
    const unsubscribe = host.subscribeLocaleHints((hints) => {
      get().applyHostLocaleHints(hints);
      void probePythonLocaleMetadata().catch(() => undefined);
    });
    hostLocaleUnsubscribe = () => {
      unsubscribe();
      hostLocaleUnsubscribe = null;
    };
    return hostLocaleUnsubscribe;
  },
  async preload(fetchImpl, signal) {
    set({ loading: true, error: null });
    try {
      get().subscribeToHostLocaleHints();
      const host = typeof window !== "undefined" ? readHostLocaleApi(promptAgentNamespace(window)?.hostApi) : null;
      if (host?.getLocaleHints) {
        get().applyHostLocaleHints(host.getLocaleHints());
      }
      await probePythonLocaleMetadata(fetchImpl).catch(() => undefined);
      const preloaded = await preloadPythonBundles(fetchImpl, "/prompt-agent/api/i18n", signal);
      get().setBundles(preloaded);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loading: false });
    }
  },
  t(key) {
    return translate(key, get().locale, get().bundles);
  },
  reset() {
    const browserLanguages = readBrowserLanguages();
    const manualLocale = readManualLocale();
    const forgeLocale = recognizedLocale(readForgeLocale());
    set({
      locale: chooseLocale(manualLocale, forgeLocale, browserLanguages),
      manualLocale,
      forgeLocale,
      browserLanguages,
      bundles: {},
      metadata: {},
      loading: false,
      error: null,
    });
  },
}));

export { metadataForBundle, recognizedLocale, selectLocale };
