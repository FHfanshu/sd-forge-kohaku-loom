import {
  profilePatchSchema,
  profileStateInputSchema,
  profileStateSchema,
  profileSchema,
  type Profile,
  type ProfileCapabilities,
  type ProfileModelInfo,
  type ProfileParameters,
  type ProfilePatch,
  type ProfileProtocol,
  type ProfileRuntime,
  type ProfileState,
} from "./contracts";
import { supportsAgentChat } from "./providers/profile-capabilities";

type RecordValue = Record<string, unknown>;

const DEFAULT_ENDPOINT = "http://127.0.0.1:8080/v1";
const DEFAULT_MODEL_ID = "local-model";

const DEFAULT_CAPABILITIES: ProfileCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  reasoning: true,
  attachments: true,
  systemPrompt: true,
  usage: true,
  abort: true,
};

const DEFAULT_PARAMETERS: ProfileParameters = {
  temperature: 0.25,
  topP: 0.9,
  maxTokens: 8192,
  reasoningEffort: "low",
  timeout: 180,
  sanitizeSensitive: true,
  teacherMode: "qwen-redact",
};

const DEFAULT_MODEL_INFO: ProfileModelInfo = {
  source: "",
  providerId: "",
  matchedModelId: "",
  contextLimit: 0,
  outputLimit: 0,
  temperatureSupported: true,
  reasoningToggle: false,
  reasoningEfforts: [],
  syncedAt: "",
};

function objectValue(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function firstValue(source: RecordValue, keys: string[], fallback: unknown = ""): unknown {
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key];
  return fallback;
}

function stringValue(source: RecordValue, keys: string[], fallback = ""): string {
  return String(firstValue(source, keys, fallback) ?? fallback);
}

function numberValue(source: RecordValue, keys: string[], fallback: number, minimum = -Infinity, maximum = Infinity): number {
  const value = Number(firstValue(source, keys, fallback));
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function booleanValue(source: RecordValue, keys: string[], fallback: boolean): boolean {
  const value = firstValue(source, keys, fallback);
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on", "enabled"].includes(String(value).trim().toLowerCase());
}

function arrayValue(source: RecordValue, keys: string[], fallback: string[] = []): string[] {
  const value = firstValue(source, keys, fallback);
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : fallback;
  return Array.from(new Set(values.map((item) => String(item).trim()).filter(Boolean)));
}

function profileId(value: unknown, fallback: string): string {
  const normalized = String(value ?? "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function normalizeProtocol(value: unknown, fallback: ProfileProtocol): ProfileProtocol {
  return value === "gemini-native" || value === "anthropic-native" || value === "openai-chat-completions" ? value : fallback;
}

function normalizeRuntime(value: unknown, fallback: ProfileRuntime): ProfileRuntime {
  return value === "remote-http" || value === "llama-endpoint" || value === "llama-once" ? value : fallback;
}

function normalizeCapabilities(raw: unknown, fallback = DEFAULT_CAPABILITIES): ProfileCapabilities {
  const source = objectValue(raw);
  const attachmentFallback = source.attachments === undefined && typeof source.vision === "boolean"
    ? source.vision
    : fallback.attachments ?? fallback.vision;
  return {
    tools: booleanValue(source, ["tools"], fallback.tools),
    vision: booleanValue(source, ["vision"], fallback.vision),
    streaming: booleanValue(source, ["streaming"], fallback.streaming),
    reasoning: booleanValue(source, ["reasoning"], fallback.reasoning),
    attachments: booleanValue(source, ["attachments"], attachmentFallback),
    systemPrompt: booleanValue(source, ["systemPrompt", "system_prompt"], fallback.systemPrompt ?? true),
    usage: booleanValue(source, ["usage"], fallback.usage ?? true),
    abort: booleanValue(source, ["abort"], fallback.abort ?? true),
  };
}

function normalizeParameters(raw: unknown, fallback = DEFAULT_PARAMETERS): ProfileParameters {
  const source = objectValue(raw);
  return {
    temperature: numberValue(source, ["temperature"], fallback.temperature, 0, 2),
    topP: numberValue(source, ["topP", "top_p"], fallback.topP, 0, 1),
    maxTokens: Math.round(numberValue(source, ["maxTokens", "max_tokens"], fallback.maxTokens, 1, 1048576)),
    reasoningEffort: stringValue(source, ["reasoningEffort", "reasoning_effort"], fallback.reasoningEffort) || fallback.reasoningEffort,
    timeout: Math.round(numberValue(source, ["timeout"], fallback.timeout, 1, 3600)),
    sanitizeSensitive: booleanValue(source, ["sanitizeSensitive", "sanitize_sensitive"], fallback.sanitizeSensitive),
    teacherMode: stringValue(source, ["teacherMode", "teacher_mode"], fallback.teacherMode) || fallback.teacherMode,
  };
}

function normalizeModelInfo(raw: unknown, fallback = DEFAULT_MODEL_INFO): ProfileModelInfo {
  const source = objectValue(raw);
  return {
    source: stringValue(source, ["source"], fallback.source),
    providerId: stringValue(source, ["providerId", "provider_id"], fallback.providerId),
    matchedModelId: stringValue(source, ["matchedModelId", "matched_model_id"], fallback.matchedModelId),
    contextLimit: Math.round(numberValue(source, ["contextLimit", "context_limit"], fallback.contextLimit, 0, 10485760)),
    outputLimit: Math.round(numberValue(source, ["outputLimit", "output_limit"], fallback.outputLimit, 0, 1048576)),
    temperatureSupported: booleanValue(source, ["temperatureSupported", "temperature_supported"], fallback.temperatureSupported),
    reasoningToggle: booleanValue(source, ["reasoningToggle", "reasoning_toggle"], fallback.reasoningToggle),
    reasoningEfforts: arrayValue(source, ["reasoningEfforts", "reasoning_efforts"], fallback.reasoningEfforts),
    syncedAt: stringValue(source, ["syncedAt", "synced_at"], fallback.syncedAt),
  };
}

export function normalizeProfile(raw: unknown, fallback?: Partial<Profile>): Profile {
  const source = objectValue(raw);
  const base = objectValue(fallback);
  const baseCapabilities = normalizeCapabilities(base.capabilities);
  const baseParameters = normalizeParameters(base.parameters);
  const baseModelInfo = normalizeModelInfo(base.modelInfo);
  const runtime = normalizeRuntime(firstValue(source, ["runtime"], base.runtime), normalizeRuntime(base.runtime, "remote-http"));
  const protocol = normalizeProtocol(
    firstValue(source, ["protocol"], base.protocol),
    normalizeProtocol(base.protocol, "openai-chat-completions"),
  );
  const modelId = stringValue(source, ["modelId", "model_id", "model"], stringValue(base, ["modelId", "model_id", "model"], DEFAULT_MODEL_ID));
  const providerId = stringValue(source, ["providerId", "provider_id"], stringValue(base, ["providerId", "provider_id"], "")).trim();
  const modelInfo = normalizeModelInfo(firstValue(source, ["modelInfo", "model_info"]), baseModelInfo);
  if (providerId && !modelInfo.providerId) modelInfo.providerId = providerId;
  const normalized: Profile = {
    id: profileId(firstValue(source, ["id", "profileId", "profile_id"]), profileId(firstValue(base, ["id", "profileId", "profile_id"]), "profile")),
    displayName: stringValue(source, ["displayName", "display_name", "name"], stringValue(base, ["displayName", "display_name", "name"], "Model profile")).trim() || "Model profile",
    modelId: modelId.trim() || DEFAULT_MODEL_ID,
    enabled: booleanValue(source, ["enabled"], booleanValue(base, ["enabled"], true)),
    protocol,
    runtime,
    endpoint: stringValue(source, ["endpoint"], stringValue(base, ["endpoint"], runtime === "remote-http" ? "" : DEFAULT_ENDPOINT)).trim().replace(/\/+$/, ""),
    fallbackEndpoints: arrayValue(source, ["fallbackEndpoints", "fallback_endpoints"], arrayValue(base, ["fallbackEndpoints", "fallback_endpoints"])),
    hasApiKey: booleanValue(source, ["hasApiKey", "has_api_key"], booleanValue(base, ["hasApiKey", "has_api_key"], false)),
    capabilities: normalizeCapabilities(source.capabilities, baseCapabilities),
    parameters: normalizeParameters(source.parameters, baseParameters),
    modelInfo,
    localModelConfigured: booleanValue(source, ["localModelConfigured", "local_model_configured"], booleanValue(base, ["localModelConfigured", "local_model_configured"], false)),
    mmprojConfigured: booleanValue(source, ["mmprojConfigured", "mmproj_configured"], booleanValue(base, ["mmprojConfigured", "mmproj_configured"], false)),
    llamaServerConfigured: booleanValue(source, ["llamaServerConfigured", "llama_server_configured"], booleanValue(base, ["llamaServerConfigured", "llama_server_configured"], false)),
    nCtx: Math.round(numberValue(source, ["nCtx", "n_ctx", "localNCtx", "local_n_ctx"], numberValue(base, ["nCtx", "n_ctx"], 16384), 1024, 1048576)),
    nGpuLayers: Math.round(numberValue(source, ["nGpuLayers", "n_gpu_layers", "localNGpuLayers", "local_n_gpu_layers"], numberValue(base, ["nGpuLayers", "n_gpu_layers"], -1), -1, 10000)),
    thinking: booleanValue(source, ["thinking", "localTextThinking", "local_text_thinking", "enableThinking"], booleanValue(base, ["thinking"], false)),
  };
  if (providerId) normalized.providerId = providerId;
  if (normalized.runtime !== "remote-http" && ["gemini-native", "anthropic-native"].includes(normalized.protocol)) normalized.protocol = "openai-chat-completions";
  if (normalized.runtime === "llama-once") normalized.endpoint = normalized.endpoint || DEFAULT_ENDPOINT;
  return profileSchema.parse(normalized);
}

const DEFAULT_PROFILE_SEEDS: Array<Partial<Profile>> = [
  { id: "gemini", displayName: "Gemini", modelId: "gemini-model", enabled: true, protocol: "gemini-native", runtime: "remote-http", endpoint: "https://generativelanguage.googleapis.com", fallbackEndpoints: [], capabilities: { ...DEFAULT_CAPABILITIES }, parameters: { ...DEFAULT_PARAMETERS, temperature: 0.35, timeout: 120 } },
  { id: "openai-compatible", displayName: "OpenAI-compatible", modelId: "model", enabled: false, protocol: "openai-chat-completions", runtime: "remote-http", endpoint: "", fallbackEndpoints: [], capabilities: { ...DEFAULT_CAPABILITIES, vision: false }, parameters: { ...DEFAULT_PARAMETERS, temperature: 0.35, timeout: 120 } },
  { id: "deepseek", displayName: "DeepSeek", modelId: "deepseek-model", enabled: false, protocol: "openai-chat-completions", runtime: "remote-http", endpoint: "https://api.deepseek.com", fallbackEndpoints: [], capabilities: { ...DEFAULT_CAPABILITIES, vision: false }, parameters: { ...DEFAULT_PARAMETERS, temperature: 0.35, timeout: 120 } },
  { id: "local-llama-endpoint", displayName: "Local llama endpoint", modelId: DEFAULT_MODEL_ID, runtime: "llama-endpoint", endpoint: DEFAULT_ENDPOINT, parameters: { ...DEFAULT_PARAMETERS } },
  { id: "local-llama-once", displayName: "Local llama one-shot", modelId: DEFAULT_MODEL_ID, enabled: false, runtime: "llama-once", endpoint: DEFAULT_ENDPOINT, parameters: { ...DEFAULT_PARAMETERS } },
];

export function createDefaultProfileState(): ProfileState {
  return {
    version: 2,
    activeProfileId: "gemini",
    teacherProfileId: "gemini",
    sessionProfileId: "local-llama-endpoint",
    namingProfileId: "",
    profiles: DEFAULT_PROFILE_SEEDS.map((profile) => normalizeProfile(profile)),
  };
}

export function normalizeProfileState(raw: unknown): ProfileState {
  const parsed = profileStateInputSchema.safeParse(objectValue(raw));
  const source = parsed.success ? parsed.data : {};
  const rawProfiles = Array.isArray(source.profiles) && source.profiles.length ? source.profiles : createDefaultProfileState().profiles;
  const seen = new Set<string>();
  const profiles = rawProfiles.map((item, index) => {
    const normalized = normalizeProfile(item, createDefaultProfileState().profiles[index] ?? createDefaultProfileState().profiles[0]);
    let id = normalized.id;
    let suffix = 2;
    while (seen.has(id)) id = `${normalized.id}-${suffix++}`;
    seen.add(id);
    return { ...normalized, id };
  });
  if (!profiles.some((profile) => profile.enabled)) profiles[0].enabled = true;
  const enabled = profiles.filter((profile) => profile.enabled);
  const enabledIds = new Set(enabled.map((profile) => profile.id));
  const agentProfiles = enabled.filter(supportsAgentChat);
  const agentIds = new Set(agentProfiles.map((profile) => profile.id));
  const firstEnabled = agentProfiles[0]?.id ?? "";
  const requestedActive = stringValue(source, ["activeProfileId", "active_profile_id"]);
  const requestedTeacher = stringValue(source, ["teacherProfileId", "teacher_profile_id"]);
  const requestedSession = stringValue(source, ["sessionProfileId", "session_profile_id"]);
  const requestedNaming = stringValue(source, ["namingProfileId", "naming_profile_id"]);
  const localIds = enabled.filter((profile) => profile.runtime === "llama-endpoint" || profile.runtime === "llama-once").map((profile) => profile.id);
  const namingIds = enabled.filter((profile) => profile.runtime === "llama-once").map((profile) => profile.id);
  return profileStateSchema.parse({
    version: 2,
    activeProfileId: agentIds.has(requestedActive) ? requestedActive : firstEnabled,
    teacherProfileId: agentIds.has(requestedTeacher) ? requestedTeacher : firstEnabled,
    sessionProfileId: localIds.includes(requestedSession) ? requestedSession : (localIds.includes("local-llama-endpoint") ? "local-llama-endpoint" : localIds[0] ?? ""),
    namingProfileId: namingIds.includes(requestedNaming) ? requestedNaming : (namingIds.includes("local-llama-once") ? "local-llama-once" : namingIds[0] ?? ""),
    profiles,
  });
}

export function toHostProfilePatch(patch: ProfilePatch | Partial<Profile>): RecordValue {
  const source = profilePatchSchema.parse(patch) as RecordValue;
  const result: RecordValue = {};
  const copy = (camel: string, snake: string) => { if (source[camel] !== undefined) result[snake] = source[camel]; };
  ["providerId", "displayName", "modelId", "enabled", "protocol", "runtime", "endpoint", "fallbackEndpoints", "hasApiKey", "modelPath", "mmprojPath", "llamaServerPath", "nCtx", "nGpuLayers", "thinking"].forEach((key) => {
    const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    copy(key, snake);
  });
  const copyNested = (sourceKey: string, targetKey: string, keys: Array<[string, string]>): void => {
    const nested = objectValue(source[sourceKey]);
    if (!source[sourceKey]) return;
    const target: RecordValue = {};
    keys.forEach(([from, to]) => { if (nested[from] !== undefined) target[to] = nested[from]; });
    result[targetKey] = target;
  };
  copyNested("capabilities", "capabilities", [["tools", "tools"], ["vision", "vision"], ["streaming", "streaming"], ["reasoning", "reasoning"], ["attachments", "attachments"], ["systemPrompt", "system_prompt"], ["usage", "usage"], ["abort", "abort"]]);
  copyNested("parameters", "parameters", [["temperature", "temperature"], ["topP", "top_p"], ["top_p", "top_p"], ["maxTokens", "max_tokens"], ["max_tokens", "max_tokens"], ["reasoningEffort", "reasoning_effort"], ["reasoning_effort", "reasoning_effort"], ["timeout", "timeout"], ["sanitizeSensitive", "sanitize_sensitive"], ["sanitize_sensitive", "sanitize_sensitive"], ["teacherMode", "teacher_mode"], ["teacher_mode", "teacher_mode"]]);
  copyNested("modelInfo", "model_info", [["source", "source"], ["providerId", "provider_id"], ["provider_id", "provider_id"], ["matchedModelId", "matched_model_id"], ["matched_model_id", "matched_model_id"], ["contextLimit", "context_limit"], ["context_limit", "context_limit"], ["outputLimit", "output_limit"], ["output_limit", "output_limit"], ["temperatureSupported", "temperature_supported"], ["temperature_supported", "temperature_supported"], ["reasoningToggle", "reasoning_toggle"], ["reasoning_toggle", "reasoning_toggle"], ["reasoningEfforts", "reasoning_efforts"], ["reasoning_efforts", "reasoning_efforts"], ["syncedAt", "synced_at"], ["synced_at", "synced_at"]]);
  return result;
}

export function toHostProfileInput(profile: Partial<Profile>): RecordValue {
  const result = toHostProfilePatch(profile);
  if (profile.id) result.id = profile.id;
  return result;
}

export function toHostProfileState(state: ProfileState): RecordValue {
  const normalized = profileStateSchema.parse(state);
  return {
    version: normalized.version,
    active_profile_id: normalized.activeProfileId,
    teacher_profile_id: normalized.teacherProfileId,
    session_profile_id: normalized.sessionProfileId,
    naming_profile_id: normalized.namingProfileId,
    profiles: normalized.profiles.map(toHostProfileInput),
  };
}
