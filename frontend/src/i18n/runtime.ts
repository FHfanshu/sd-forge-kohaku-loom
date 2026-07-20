import {
  localeCodes,
  localeMetadataSchema,
  parseBoundary,
  pythonTranslationBundleSchema,
  localeMetadataResponseSchema,
  type LocaleCode,
  type LocaleMetadata,
  type LocaleMetadataResponse,
  type PythonTranslationBundle,
} from "../contracts";

export interface PythonI18nResponse extends PythonTranslationBundle {
  metadata?: LocaleMetadata;
}

export interface PythonI18nContract {
  endpoint: "/prompt-agent/api/i18n";
  metadataEndpoint: "/prompt-agent/api/i18n/locale";
  supportedLocales: readonly LocaleCode[];
  fallbackLocale: "en";
  response: PythonI18nResponse;
}

export interface RuntimeLocaleMetadata {
  code: LocaleCode;
  label: string;
  direction: "ltr" | "rtl";
  source: "python-runtime";
}

export interface PreloadedBundles {
  bundles: Record<LocaleCode, PythonTranslationBundle>;
  metadata: Record<LocaleCode, RuntimeLocaleMetadata>;
}

const defaultMetadata: Record<LocaleCode, RuntimeLocaleMetadata> = {
  en: { code: "en", label: "English", direction: "ltr", source: "python-runtime" },
  "zh-CN": { code: "zh-CN", label: "简体中文", direction: "ltr", source: "python-runtime" },
};

const localFallbackMessages: Record<LocaleCode, Record<string, string>> = {
  en: {
    "profiles.tab.model": "Model", "profiles.tab.routes": "Routes", "profiles.tab.interface": "Interface", "profiles.advanced_tabs": "Advanced profile settings",
    "profiles.routes.title": "Routing", "profiles.routes.hint": "Choose which enabled profile handles each assistant role.", "profiles.active_profile": "Active profile", "profiles.route.active.hint": "Used for the main chat route", "profiles.route.naming.hint": "Creates titles with a llama-once profile", "profiles.role.naming.short": "N",
    "profiles.api_key.stored": "Stored securely", "profiles.api_key.placeholder": "Paste an API key", "profiles.model_path.empty": "Model path not configured", "profiles.resize": "Resize profile window",
    "profiles.delete.confirm_action": "Delete profile", "profiles.restore.confirm_action": "Restore defaults", "common.cancel": "Cancel",
    "profiles.interface.hint": "Tune the floating windows without changing chat content.", "profiles.interface.layouts": "Window layouts", "profiles.interface.layouts_hint": "Reset both chat and profile window positions and sizes to their defaults.", "profiles.interface.reset": "Reset window layouts", "profiles.interface.mobile": "Mobile resize hint", "profiles.interface.mobile_hint": "Drag the corner to resize on mobile", "profiles.interface.dismiss_hint": "Dismiss", "profiles.interface.hint_seen": "Dismissed",
  },
  "zh-CN": {
    "profiles.tab.model": "模型", "profiles.tab.routes": "路由", "profiles.tab.interface": "界面", "profiles.advanced_tabs": "高级模型设置",
    "profiles.routes.title": "路由分配", "profiles.routes.hint": "为每个助手角色选择启用的模型配置。", "profiles.active_profile": "主模型", "profiles.route.active.hint": "用于主要对话路由", "profiles.route.naming.hint": "使用 llama-once 模型生成标题", "profiles.role.naming.short": "命",
    "profiles.api_key.stored": "已安全保存", "profiles.api_key.placeholder": "粘贴 API Key", "profiles.model_path.empty": "尚未配置模型路径", "profiles.resize": "调整模型配置窗口大小",
    "profiles.delete.confirm_action": "删除配置", "profiles.restore.confirm_action": "恢复默认配置", "common.cancel": "取消",
    "profiles.interface.hint": "调整浮动窗口，不会改变对话内容。", "profiles.interface.layouts": "窗口布局", "profiles.interface.layouts_hint": "将聊天窗口和模型配置窗口的位置与大小恢复为默认值。", "profiles.interface.reset": "重置窗口布局", "profiles.interface.mobile": "移动端调整提示", "profiles.interface.mobile_hint": "拖动窗口角落调整移动端大小", "profiles.interface.dismiss_hint": "关闭提示", "profiles.interface.hint_seen": "已关闭",
  },
};

export function normalizeLocale(value: unknown): LocaleCode {
  const raw = String(value ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (raw.startsWith("zh") || raw === "cn" || raw === "中文") return "zh-CN";
  return "en";
}

export function recognizedLocale(value: unknown): LocaleCode | null {
  const raw = String(value ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (raw.startsWith("zh") || raw === "cn" || raw === "中文") return "zh-CN";
  if (raw.startsWith("en") || raw === "english") return "en";
  return null;
}

function localeFromCandidates(value: unknown): LocaleCode | null {
  const candidates = Array.isArray(value) ? value : [value];
  for (const candidate of candidates) {
    const locale = recognizedLocale(candidate);
    if (locale) return locale;
  }
  return null;
}

export function selectLocale(options: {
  explicit?: unknown;
  runtime?: unknown;
  browser?: unknown;
  manual?: unknown;
  forge?: unknown;
  navigatorLanguages?: readonly unknown[];
}): LocaleCode {
  const manual = options.manual ?? options.explicit;
  const forge = options.forge ?? options.runtime;
  const browser = options.navigatorLanguages ?? options.browser;
  for (const candidate of [manual, forge, browser]) {
    const locale = localeFromCandidates(candidate);
    if (locale) return locale;
  }
  return "en";
}

export function metadataForBundle(bundle: PythonTranslationBundle): RuntimeLocaleMetadata {
  const metadata = bundle.metadata ?? defaultMetadata[bundle.locale];
  return parseBoundary(localeMetadataSchema, metadata, "i18n metadata");
}

export function parseLocaleMetadata(value: unknown): LocaleMetadataResponse {
  return parseBoundary(localeMetadataResponseSchema, value, "i18n locale metadata");
}

export function mergeMessages(
  selected: PythonTranslationBundle,
  fallback: PythonTranslationBundle,
): Record<string, string> {
  return {
    ...fallback.messages,
    ...selected.messages,
  };
}

export function translate(
  key: string,
  locale: LocaleCode,
  bundles: Partial<Record<LocaleCode, PythonTranslationBundle>>,
): string {
  const selected = bundles[locale]?.messages[key];
  if (selected) return selected;
  const fallback = bundles.en?.messages[key];
  return fallback ?? localFallbackMessages[locale][key] ?? localFallbackMessages.en[key] ?? key;
}

export async function preloadPythonBundles(
  fetchImpl: typeof fetch = fetch,
  endpoint = "/prompt-agent/api/i18n",
  signal?: AbortSignal,
): Promise<PreloadedBundles> {
  const entries = await Promise.all(
    localeCodes.map(async (locale) => {
      if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      const separator = endpoint.includes("?") ? "&" : "?";
      const response = await fetchImpl(`${endpoint}${separator}locale=${encodeURIComponent(locale)}`, { signal });
      if (!response.ok) throw new Error(`i18n preload failed for ${locale}: HTTP ${response.status}`);
      const bundle = parseBoundary(
        pythonTranslationBundleSchema,
        await response.json(),
        `i18n ${locale}`,
      );
      if (bundle.locale !== locale) throw new Error(`i18n ${locale} returned ${bundle.locale}`);
      return [locale, bundle] as const;
    }),
  );
  const bundles = Object.fromEntries(entries) as Record<LocaleCode, PythonTranslationBundle>;
  return {
    bundles,
    metadata: {
      en: metadataForBundle(bundles.en),
      "zh-CN": metadataForBundle(bundles["zh-CN"]),
    },
  };
}

export async function probePythonLocaleMetadata(
  fetchImpl: typeof fetch = fetch,
  endpoint = "/prompt-agent/api/i18n/locale",
  signal?: AbortSignal,
): Promise<LocaleMetadataResponse> {
  const response = await fetchImpl(endpoint, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`i18n locale metadata failed: HTTP ${response.status}`);
  return parseLocaleMetadata(await response.json());
}
