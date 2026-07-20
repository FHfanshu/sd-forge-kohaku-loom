import { z } from "zod";
import { profileCapabilitiesSchema, profileModelInfoSchema, profileProtocolSchema, profileRuntimeSchema, type Profile, type ProfilePatch, type ProfileState } from "./contracts";
import { normalizeProfile, normalizeProfileState, toHostProfileInput, toHostProfilePatch } from "./profile-adapter";

const API = "/prompt-agent/api";

const publicModelSchema = z.object({
  id: z.string().min(1),
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  enabled: z.boolean(),
  protocol: profileProtocolSchema,
  runtime: profileRuntimeSchema,
  hasApiKey: z.boolean(),
  capabilities: profileCapabilitiesSchema.partial(),
  modelInfo: profileModelInfoSchema,
  localModelConfigured: z.boolean(),
  mmprojConfigured: z.boolean(),
  llamaServerConfigured: z.boolean(),
});
const publicModelStateSchema = z.object({ version: z.literal(1), models: z.array(publicModelSchema) });
export type PublicModelState = z.infer<typeof publicModelStateSchema>;

async function request<T>(path: string, init?: RequestInit, parse?: (value: unknown) => T): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json() as { detail?: unknown };
      const error = payload.detail && typeof payload.detail === "object" ? (payload.detail as { error?: { message?: unknown } }).error : undefined;
      detail = typeof error?.message === "string" ? error.message : typeof payload.detail === "string" ? payload.detail : "";
    } catch {
      detail = "";
    }
    throw new Error(detail || `Prompt Agent profile request failed with HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  const value = await response.json() as unknown;
  return parse ? parse(value) : value as T;
}

export function listProfiles(): Promise<ProfileState> {
  return request<ProfileState>("/profiles", undefined, normalizeProfileState);
}

export function listModels(): Promise<PublicModelState> {
  return request<PublicModelState>("/models", undefined, (value) => publicModelStateSchema.parse(value));
}

export function listProfileModels(profileId: string): Promise<PublicModelState> {
  return request<PublicModelState>(`/profiles/${encodeURIComponent(profileId)}/models`, undefined, (value) => publicModelStateSchema.parse(value));
}

export function importProfiles(state: Record<string, unknown>): Promise<ProfileState> {
  return request<ProfileState>("/profiles/import", { method: "POST", body: JSON.stringify(state) }, normalizeProfileState);
}

export function createProfile(profile: Partial<Profile>): Promise<Profile> {
  return request<Profile>("/profiles", { method: "POST", body: JSON.stringify(toHostProfileInput(profile)) }, (value) => normalizeProfile(value));
}

export function updateProfile(profileId: string, patch: ProfilePatch | Record<string, unknown>): Promise<Profile> {
  const payload = "api_key" in patch ? patch : toHostProfilePatch(patch as ProfilePatch);
  return request<Profile>(`/profiles/${encodeURIComponent(profileId)}`, { method: "PATCH", body: JSON.stringify(payload) }, (value) => normalizeProfile(value));
}

export function deleteProfile(profileId: string): Promise<void> {
  return request<void>(`/profiles/${encodeURIComponent(profileId)}`, { method: "DELETE" });
}

export function duplicateProfile(profileId: string): Promise<Profile> {
  return request<Profile>(`/profiles/${encodeURIComponent(profileId)}/duplicate`, { method: "POST" }, (value) => normalizeProfile(value));
}

export function setProfileRoute(role: "active" | "teacher" | "session" | "naming", profileId: string): Promise<ProfileState> {
  return request<ProfileState>("/profile-routes/default", { method: "POST", body: JSON.stringify({ role, profile_id: profileId }) }, normalizeProfileState);
}

export function restoreDefaultProfiles(): Promise<ProfileState> {
  return request<ProfileState>("/profiles/restore-defaults", { method: "POST" }, normalizeProfileState);
}

export function testProfileConnection(profileId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(`/profiles/${encodeURIComponent(profileId)}/connection-test`, { method: "POST", signal });
}
