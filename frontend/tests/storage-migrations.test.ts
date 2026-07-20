import { afterEach, describe, expect, it } from "vitest";
import {
  LEGACY_STORAGE_KEYS,
  PROMPT_AGENT_STORAGE_KEYS,
  readMigratedStorageValue,
  removePromptAgentStorageValue,
  writePromptAgentStorageValue,
} from "../src/storage-migrations";

afterEach(() => {
  localStorage.clear();
});

describe("Prompt Agent localStorage migrations", () => {
  it("migrates every persisted key from the old key once", () => {
    for (const name of Object.keys(PROMPT_AGENT_STORAGE_KEYS) as Array<keyof typeof PROMPT_AGENT_STORAGE_KEYS>) {
      const canonicalKey = PROMPT_AGENT_STORAGE_KEYS[name];
      const legacyKey = LEGACY_STORAGE_KEYS[name];
      const value = `migration-${name}`;
      localStorage.setItem(legacyKey, value);

      expect(readMigratedStorageValue(localStorage, canonicalKey, legacyKey)).toBe(value);
      expect(localStorage.getItem(canonicalKey)).toBe(value);
      expect(localStorage.getItem(legacyKey)).toBeNull();
    }
  });

  it("prefers canonical data and removes stale old data without overwriting it", () => {
    const canonicalKey = PROMPT_AGENT_STORAGE_KEYS.locale;
    const legacyKey = LEGACY_STORAGE_KEYS.locale;
    localStorage.setItem(canonicalKey, "zh-CN");
    localStorage.setItem(legacyKey, "en");

    expect(readMigratedStorageValue(localStorage, canonicalKey, legacyKey)).toBe("zh-CN");
    expect(localStorage.getItem(canonicalKey)).toBe("zh-CN");
    expect(localStorage.getItem(legacyKey)).toBeNull();
  });

  it("writes and removes only the canonical key", () => {
    const canonicalKey = PROMPT_AGENT_STORAGE_KEYS.modelPickerFavorites;
    const legacyKey = LEGACY_STORAGE_KEYS.modelPickerFavorites;
    localStorage.setItem(legacyKey, "old");

    writePromptAgentStorageValue(localStorage, canonicalKey, legacyKey, "new");
    expect(localStorage.getItem(canonicalKey)).toBe("new");
    expect(localStorage.getItem(legacyKey)).toBeNull();

    removePromptAgentStorageValue(localStorage, canonicalKey, legacyKey);
    expect(localStorage.getItem(canonicalKey)).toBeNull();
    expect(localStorage.getItem(legacyKey)).toBeNull();
  });
});
