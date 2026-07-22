import { profilePatchSchema, type Profile, type ProfilePatch, type ProfileState, type ProfileStoreActionContracts } from "../contracts";
import * as api from "../profile-api";
import { createDefaultProfileState, normalizeProfile, normalizeProfileState } from "../profile-adapter";
import { supportsAgentChat } from "../providers/profile-capabilities";
import { createStore } from "./store";

function nextId(prefix: string, profiles: Profile[]): string {
  const used = new Set(profiles.map((profile) => profile.id));
  let index = 1;
  let id = `${prefix}-${index}`;
  while (used.has(id)) id = `${prefix}-${++index}`;
  return id;
}

export interface ProfileStore extends ProfileStoreActionContracts {
  profiles: Profile[];
  activeProfileId: string;
  sessionProfileId: string;
  namingProfileId: string;
  selectedProfileId: string;
  loaded: boolean;
}

function stateSlice(state: ProfileState): Pick<ProfileStore, "profiles" | "activeProfileId" | "sessionProfileId" | "namingProfileId"> {
  return {
    profiles: state.profiles,
    activeProfileId: state.activeProfileId,
    sessionProfileId: state.sessionProfileId,
    namingProfileId: state.namingProfileId,
  };
}

export const useProfileStore = createStore<ProfileStore>((set, get) => {
  const defaults = createDefaultProfileState();
  const apply = (raw: unknown, selectedProfileId = get().selectedProfileId): void => {
    const state = normalizeProfileState(raw);
    const selected = state.profiles.some((profile) => profile.id === selectedProfileId) ? selectedProfileId : state.activeProfileId;
    set({ ...stateSlice(state), selectedProfileId: selected, loaded: true });
  };
  const persist = (operation: Promise<unknown>): void => { void operation.catch(() => undefined); };
  const reload = (): void => { persist(api.listProfiles().then((state) => apply(state))); };
  const updateLocal = (profileId: string, patch: ProfilePatch): Profile | null => {
    const current = get();
    const source = current.profiles.find((profile) => profile.id === profileId);
    if (!source) return null;
    const value = profilePatchSchema.parse(patch);
    const updated = normalizeProfile({
      ...source,
      ...value,
      id: source.id,
      capabilities: { ...source.capabilities, ...value.capabilities },
      parameters: { ...source.parameters, ...value.parameters },
      modelInfo: { ...source.modelInfo, ...value.modelInfo },
    });
    apply({ ...current, profiles: current.profiles.map((profile) => profile.id === profileId ? updated : profile) });
    return updated;
  };

  return {
    ...stateSlice(defaults),
    selectedProfileId: defaults.activeProfileId,
    loaded: false,
    reload,
    setState: apply,
    setProfiles(profiles) { apply({ ...get(), profiles }); },
    upsertProfile(profile) { apply({ ...get(), profiles: [...get().profiles.filter((item) => item.id !== profile.id), normalizeProfile(profile)] }, profile.id); },
    selectProfile(profileId) { if (get().profiles.some((profile) => profile.id === profileId)) set({ selectedProfileId: profileId }); },
    addProfile(seed = {}) {
      const local = normalizeProfile({ ...seed, id: seed.id ?? nextId("profile", get().profiles), displayName: seed.displayName ?? "New profile", modelId: seed.modelId ?? "model" });
      apply({ ...get(), profiles: [...get().profiles, local] }, local.id);
      persist(api.createProfile(local).then((remote) => {
        const current = get();
        apply({ ...current, profiles: current.profiles.map((profile) => profile.id === local.id ? normalizeProfile(remote, profile) : profile) }, remote.id);
      }));
      return local;
    },
    duplicateProfile(profileId) {
      const source = get().profiles.find((profile) => profile.id === profileId);
      if (!source) return null;
      const copy = normalizeProfile({ ...source, id: nextId(source.id, get().profiles), displayName: `${source.displayName} copy` });
      apply({ ...get(), profiles: [...get().profiles, copy] }, copy.id);
      persist(api.duplicateProfile(profileId).then((remote) => {
        const current = get();
        apply({ ...current, profiles: current.profiles.map((profile) => profile.id === copy.id ? normalizeProfile(remote, copy) : profile) }, remote.id);
      }));
      return copy;
    },
    updateProfile(profileId, patch) {
      const updated = updateLocal(profileId, patch);
      if (updated) persist(api.updateProfile(profileId, patch).then((remote) => updateLocal(profileId, normalizeProfile(remote, updated))));
      return updated;
    },
    async deleteProfile(profileId) {
      const current = get();
      if (!current.profiles.some((profile) => profile.id === profileId) || current.profiles.length <= 1) return false;
      await api.deleteProfile(profileId);
      const latest = get();
      apply({ ...latest, profiles: latest.profiles.filter((profile) => profile.id !== profileId) });
      return true;
    },
    activateProfile(profileId) {
      if (!get().profiles.some((profile) => profile.id === profileId && profile.enabled && supportsAgentChat(profile))) return;
      set({ activeProfileId: profileId });
      persist(api.setProfileRoute("active", profileId).then((state) => apply(state)));
    },
    setSessionProfile(profileId) {
      if (!get().profiles.some((profile) => profile.runtime === "llama-once" && profile.id === profileId && profile.enabled)) return;
      set({ sessionProfileId: profileId });
      persist(api.setProfileRoute("session", profileId).then((state) => apply(state)));
    },
    setNamingProfile(profileId) {
      if (!get().profiles.some((profile) => profile.runtime === "llama-once" && profile.id === profileId && profile.enabled)) return;
      set({ namingProfileId: profileId });
      persist(api.setProfileRoute("naming", profileId).then((state) => apply(state)));
    },
    restoreDefaults() {
      apply(defaults, defaults.activeProfileId);
      persist(api.restoreDefaultProfiles().then((state) => apply(state, state.activeProfileId)));
    },
    reset() { set({ ...stateSlice(defaults), selectedProfileId: defaults.activeProfileId, loaded: false }); },
  };
});
