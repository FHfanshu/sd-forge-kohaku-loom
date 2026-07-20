import { describe, expect, it } from "vitest";
import { metadataForBundle, parseLocaleMetadata, preloadPythonBundles, selectLocale, translate } from "../src/i18n/runtime";
import { useI18nStore } from "../src/stores/i18n";

const en = {
  locale: "en" as const,
  fallback_locale: "en" as const,
  content_version: "sha256:en",
  messages: { greeting: "Hello", fallback: "English fallback" },
};
const zh = {
  locale: "zh-CN" as const,
  fallback_locale: "en" as const,
  content_version: "sha256:zh",
  messages: { greeting: "你好" },
};

describe("runtime i18n contract", () => {
  it("uses explicit, then Python runtime, then browser locale precedence", () => {
    expect(selectLocale({ explicit: "en-US", runtime: "zh-CN", browser: "zh-CN" })).toBe("en");
    expect(selectLocale({ runtime: "zh-CN", browser: "en-US" })).toBe("zh-CN");
    expect(selectLocale({ runtime: "unknown", browser: "en-US" })).toBe("en");
  });

  it("normalizes every Chinese variant to zh-CN and keeps manual locale first", () => {
    expect(selectLocale({ manual: "zh_TW", forge: "en", navigatorLanguages: ["en-US"] })).toBe("zh-CN");
    expect(selectLocale({ manual: "", forge: "zh_CN", navigatorLanguages: ["en-US"] })).toBe("zh-CN");
  });

  it("falls back to English only for missing selected keys", () => {
    expect(translate("greeting", "zh-CN", { en, "zh-CN": zh })).toBe("你好");
    expect(translate("fallback", "zh-CN", { en, "zh-CN": zh })).toBe("English fallback");
    expect(metadataForBundle(zh)).toMatchObject({ code: "zh-CN", source: "python-runtime" });
  });

  it("keeps the two preloaded bundles and runtime metadata in the store", () => {
    useI18nStore.getState().reset();
    useI18nStore.getState().setBundles({
      bundles: { en, "zh-CN": zh },
      metadata: {
        en: metadataForBundle(en),
        "zh-CN": metadataForBundle(zh),
      },
    });
    useI18nStore.getState().setLocale("zh-CN");
    expect(useI18nStore.getState().t("greeting")).toBe("你好");
    expect(Object.keys(useI18nStore.getState().bundles)).toEqual(["en", "zh-CN"]);
  });

  it("preloads both specified, content-versioned bundles", async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(url);
      const bundle = url.includes("zh-CN") ? zh : en;
      return new Response(JSON.stringify(bundle), { status: 200, headers: { "content-type": "application/json" } });
    });
    const result = await preloadPythonBundles(fetchImpl as unknown as typeof fetch);
    expect(requested).toEqual([
      "/prompt-agent/api/i18n?locale=en",
      "/prompt-agent/api/i18n?locale=zh-CN",
    ]);
    expect(result.bundles.en.content_version).toBe("sha256:en");
    expect(result.bundles["zh-CN"].content_version).toBe("sha256:zh");
  });

  it("validates lightweight Python locale metadata", () => {
    expect(parseLocaleMetadata({
      locale: "zh-CN",
      fallback_locale: "en",
      supported_locales: ["zh-CN", "en"],
      content_version: "sha256:zh",
      metadata: { code: "zh-CN", label: "简体中文", direction: "ltr", source: "python-runtime", content_version: "sha256:zh" },
    })).toMatchObject({ locale: "zh-CN", content_version: "sha256:zh" });
  });
});
