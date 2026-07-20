export const PROMPT_AGENT_STORAGE_KEYS = {
  locale: "prompt_agent_locale",
  uiLayouts: "prompt-agent:ui-layouts:v1",
  profileLayouts: "prompt-agent:profile-layouts:v2",
  launcherPosition: "prompt-agent:launcher-position:v1",
  modelPickerFavorites: "prompt-agent.model-picker.favorites",
  modelPickerRecents: "prompt-agent.model-picker.recents",
} as const;

export const LEGACY_STORAGE_KEYS = {
  locale: "loom_assistant_locale",
  uiLayouts: "kohaku-loom:ui-layouts:v1",
  profileLayouts: "kohaku-loom:profile-layouts:v2",
  launcherPosition: "kohaku-loom:launcher-position:v1",
  modelPickerFavorites: "kohaku-loom.model-picker.favorites",
  modelPickerRecents: "kohaku-loom.model-picker.recents",
} as const;

export function readMigratedStorageValue(
  storage: Storage,
  canonicalKey: string,
  legacyKey: string,
): string | null {
  try {
    const canonicalValue = storage.getItem(canonicalKey);
    if (canonicalValue !== null) {
      storage.removeItem(legacyKey);
      return canonicalValue;
    }
    const legacyValue = storage.getItem(legacyKey);
    if (legacyValue === null) return null;
    storage.setItem(canonicalKey, legacyValue);
    storage.removeItem(legacyKey);
    return legacyValue;
  } catch {
    return null;
  }
}

export function writePromptAgentStorageValue(
  storage: Storage,
  canonicalKey: string,
  legacyKey: string,
  value: string,
): void {
  try {
    storage.setItem(canonicalKey, value);
    storage.removeItem(legacyKey);
  } catch {
    // Storage can be unavailable in embedded or private browsing contexts.
  }
}

export function removePromptAgentStorageValue(
  storage: Storage,
  canonicalKey: string,
  legacyKey: string,
): void {
  try {
    storage.removeItem(canonicalKey);
    storage.removeItem(legacyKey);
  } catch {
    // Storage can be unavailable in embedded or private browsing contexts.
  }
}
