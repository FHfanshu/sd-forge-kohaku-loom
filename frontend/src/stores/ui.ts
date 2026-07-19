import { createStore } from "./store";
import { windowLayoutSchema, type WindowLayout } from "../contracts";

export type LayoutViewport = "desktop" | "mobilePortrait" | "mobileLandscape";

export interface LauncherPosition {
  left: number;
  top: number;
}

const DEFAULT_LAYOUTS: Record<LayoutViewport, WindowLayout> = {
  desktop: { left: 24, top: 9999, width: 460, height: 680 },
  mobilePortrait: { left: 12, top: 9999, width: 360, height: 560 },
  mobileLandscape: { left: 12, top: 9999, width: 430, height: 270 },
};

const DEFAULT_PROFILE_LAYOUTS: Record<LayoutViewport, WindowLayout> = {
  desktop: { left: 510, top: 76, width: 700, height: 600 },
  mobilePortrait: { left: 16, top: 16, width: 360, height: 600 },
  mobileLandscape: { left: 16, top: 16, width: 460, height: 280 },
};

const LAYOUT_STORAGE_KEY = "kohaku-loom:ui-layouts:v1";
const PROFILE_LAYOUT_STORAGE_KEY = "kohaku-loom:profile-layouts:v2";
const LAUNCHER_POSITION_STORAGE_KEY = "kohaku-loom:launcher-position:v1";

function readStoredLayouts(): Record<LayoutViewport, WindowLayout> {
  const storage = getStorage();
  if (!storage) return DEFAULT_LAYOUTS;
  try {
    const value: unknown = JSON.parse(storage.getItem(LAYOUT_STORAGE_KEY) ?? "null");
    if (!value || typeof value !== "object") return DEFAULT_LAYOUTS;
    const candidate = value as Partial<Record<LayoutViewport, unknown>>;
    return {
      desktop: windowLayoutSchema.safeParse(candidate.desktop).success
        ? windowLayoutSchema.parse(candidate.desktop)
        : DEFAULT_LAYOUTS.desktop,
      mobilePortrait: windowLayoutSchema.safeParse(candidate.mobilePortrait).success
        ? windowLayoutSchema.parse(candidate.mobilePortrait)
        : DEFAULT_LAYOUTS.mobilePortrait,
      mobileLandscape: windowLayoutSchema.safeParse(candidate.mobileLandscape).success
        ? windowLayoutSchema.parse(candidate.mobileLandscape)
        : DEFAULT_LAYOUTS.mobileLandscape,
    };
  } catch {
    return DEFAULT_LAYOUTS;
  }
}

function readStoredProfileLayouts(): Record<LayoutViewport, WindowLayout> {
  const storage = getStorage();
  if (!storage) return DEFAULT_PROFILE_LAYOUTS;
  try {
    const value: unknown = JSON.parse(storage.getItem(PROFILE_LAYOUT_STORAGE_KEY) ?? "null");
    if (!value || typeof value !== "object") return DEFAULT_PROFILE_LAYOUTS;
    const candidate = value as Partial<Record<LayoutViewport, unknown>>;
    return {
      desktop: windowLayoutSchema.safeParse(candidate.desktop).success
        ? windowLayoutSchema.parse(candidate.desktop)
        : DEFAULT_PROFILE_LAYOUTS.desktop,
      mobilePortrait: windowLayoutSchema.safeParse(candidate.mobilePortrait).success
        ? windowLayoutSchema.parse(candidate.mobilePortrait)
        : DEFAULT_PROFILE_LAYOUTS.mobilePortrait,
      mobileLandscape: windowLayoutSchema.safeParse(candidate.mobileLandscape).success
        ? windowLayoutSchema.parse(candidate.mobileLandscape)
        : DEFAULT_PROFILE_LAYOUTS.mobileLandscape,
    };
  } catch {
    return DEFAULT_PROFILE_LAYOUTS;
  }
}

function readStoredLauncherPosition(): LauncherPosition | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const value: unknown = JSON.parse(storage.getItem(LAUNCHER_POSITION_STORAGE_KEY) ?? "null");
    if (!value || typeof value !== "object") return null;
    const candidate = value as Partial<LauncherPosition>;
    return Number.isFinite(candidate.left) && Number.isFinite(candidate.top)
      ? { left: candidate.left as number, top: candidate.top as number }
      : null;
  } catch {
    return null;
  }
}

function getStorage(): Storage | null {
  try {
    const storage = typeof window !== "undefined" ? window.localStorage : undefined;
    return storage && typeof storage.getItem === "function" && typeof storage.setItem === "function"
      ? storage
      : null;
  } catch {
    return null;
  }
}

export function persistLayouts(layouts: Record<LayoutViewport, WindowLayout>): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layouts));
  } catch {
    // Storage can be unavailable in embedded or private browsing contexts.
  }
}

export function persistProfileLayouts(layouts: Record<LayoutViewport, WindowLayout>): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(PROFILE_LAYOUT_STORAGE_KEY, JSON.stringify(layouts));
  } catch {
    // Storage can be unavailable in embedded or private browsing contexts.
  }
}

export function persistLauncherPosition(position: LauncherPosition | null): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    if (position) storage.setItem(LAUNCHER_POSITION_STORAGE_KEY, JSON.stringify(position));
    else storage.removeItem(LAUNCHER_POSITION_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in embedded or private browsing contexts.
  }
}

export interface UiStore {
  shellOpen: boolean;
  profileSettingsOpen: boolean;
  activePanel: "chat" | "profiles";
  frontWindow: "chat" | "profiles";
  historyOpen: boolean;
  layouts: Record<LayoutViewport, WindowLayout>;
  profileLayouts: Record<LayoutViewport, WindowLayout>;
  launcherPosition: LauncherPosition | null;
  hasSeenMobileResizeHint: boolean;
  setShellOpen(open: boolean): void;
  setProfileSettingsOpen(open: boolean): void;
  setActivePanel(panel: UiStore["activePanel"]): void;
  bringToFront(windowName: UiStore["frontWindow"]): void;
  setHistoryOpen(open: boolean): void;
  setLayout(viewport: LayoutViewport, layout: WindowLayout): void;
  setProfileLayout(viewport: LayoutViewport, layout: WindowLayout): void;
  setLauncherPosition(position: LauncherPosition): void;
  resetWindowLayouts(): void;
  markMobileResizeHintSeen(): void;
  reset(): void;
}

export const useUiStore = createStore<UiStore>((set) => ({
  shellOpen: false,
  profileSettingsOpen: false,
  activePanel: "chat",
  frontWindow: "chat",
  historyOpen: false,
  layouts: readStoredLayouts(),
  profileLayouts: readStoredProfileLayouts(),
  launcherPosition: readStoredLauncherPosition(),
  hasSeenMobileResizeHint: false,
  setShellOpen(shellOpen) {
    set({ shellOpen });
  },
  setProfileSettingsOpen(profileSettingsOpen) {
    set({ profileSettingsOpen, frontWindow: profileSettingsOpen ? "profiles" : "chat" });
  },
  setActivePanel(activePanel) {
    set({ activePanel });
  },
  bringToFront(frontWindow) {
    set({ frontWindow, activePanel: frontWindow });
  },
  setHistoryOpen(historyOpen) {
    set({ historyOpen });
  },
  setLayout(viewport, layout) {
    set((state) => {
      const layouts = { ...state.layouts, [viewport]: windowLayoutSchema.parse(layout) };
      persistLayouts(layouts);
      return { layouts };
    });
  },
  setProfileLayout(viewport, layout) {
    set((state) => {
      const profileLayouts = { ...state.profileLayouts, [viewport]: windowLayoutSchema.parse(layout) };
      persistProfileLayouts(profileLayouts);
      return { profileLayouts };
    });
  },
  setLauncherPosition(launcherPosition) {
    persistLauncherPosition(launcherPosition);
    set({ launcherPosition });
  },
  resetWindowLayouts() {
    persistLayouts(DEFAULT_LAYOUTS);
    persistProfileLayouts(DEFAULT_PROFILE_LAYOUTS);
    persistLauncherPosition(null);
    set({ layouts: DEFAULT_LAYOUTS, profileLayouts: DEFAULT_PROFILE_LAYOUTS, launcherPosition: null, hasSeenMobileResizeHint: false });
  },
  markMobileResizeHintSeen() {
    set({ hasSeenMobileResizeHint: true });
  },
  reset() {
    set({
      shellOpen: false,
      profileSettingsOpen: false,
      activePanel: "chat",
      frontWindow: "chat",
      historyOpen: false,
      layouts: DEFAULT_LAYOUTS,
      profileLayouts: DEFAULT_PROFILE_LAYOUTS,
      launcherPosition: null,
      hasSeenMobileResizeHint: false,
    });
  },
}));

export { DEFAULT_LAYOUTS, DEFAULT_PROFILE_LAYOUTS };
