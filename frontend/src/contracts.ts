import { z } from "zod";

export const localeCodes = ["en", "zh-CN"] as const;
export const localeCodeSchema = z.enum(localeCodes);
export type LocaleCode = z.infer<typeof localeCodeSchema>;

export const localeMetadataSchema = z.object({
  code: localeCodeSchema,
  label: z.string().min(1),
  direction: z.enum(["ltr", "rtl"]),
  source: z.literal("python-runtime"),
  content_version: z.string().min(1).optional(),
});
export type LocaleMetadata = z.infer<typeof localeMetadataSchema>;

export const pythonTranslationBundleSchema = z.object({
  locale: localeCodeSchema,
  fallback_locale: localeCodeSchema,
  content_version: z.string().min(1),
  messages: z.record(z.string()),
  metadata: localeMetadataSchema.optional(),
});
export type PythonTranslationBundle = z.input<typeof pythonTranslationBundleSchema>;
export type ParsedPythonTranslationBundle = z.output<typeof pythonTranslationBundleSchema>;

export const localeMetadataResponseSchema = z.object({
  locale: localeCodeSchema,
  fallback_locale: localeCodeSchema,
  supported_locales: z.array(localeCodeSchema),
  content_version: z.string().min(1),
  metadata: localeMetadataSchema,
});
export type LocaleMetadataResponse = z.infer<typeof localeMetadataResponseSchema>;

const chatAttachmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  dataUrl: z.string().min(1).optional(),
  previewUrl: z.string().min(1).optional(),
  mimeType: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
}).refine((attachment) => Boolean(attachment.dataUrl || attachment.previewUrl), "Attachment data is unavailable");

const createdAtSchema = z.number().finite().nonnegative().transform((value) => Math.trunc(value)).default(() => Date.now());

export const chatMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "system", "error", "tool"]),
  content: z.string(),
  status: z.enum(["complete", "streaming", "cancelled", "error"]).default("complete"),
  reasoning: z.string().optional(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    latencyMs: z.number().int().nonnegative().optional(),
  }).optional(),
  tool: z.object({
    name: z.string().min(1),
    status: z.enum(["running", "complete", "error"]).default("complete"),
    detail: z.string().optional(),
    undoable: z.boolean().optional(),
    undone: z.boolean().optional(),
  }).optional(),
  attachments: z.array(chatAttachmentSchema).default([]),
  branchIndex: z.number().int().nonnegative().default(0),
  branchCount: z.number().int().positive().default(1),
  branchTurnIndex: z.number().int().nonnegative().optional(),
  createdAt: createdAtSchema,
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatMessageInput = z.input<typeof chatMessageSchema>;

export const attachmentSchema = chatAttachmentSchema;
export type ChatAttachment = z.infer<typeof attachmentSchema>;
export type WireAttachment = ChatAttachment & { dataUrl: string };

export const queuedMessageSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  attachments: z.array(attachmentSchema).default([]),
  attachmentCount: z.number().int().nonnegative().default(0),
  state: z.enum(["pending", "guide_waiting", "running", "claimed", "failed", "cancelled", "delivered"]).optional(),
  kind: z.enum(["primary", "guide"]).optional(),
  error: z.string().optional(),
  turnId: z.string().optional(),
  sequence: z.number().int().nonnegative().optional(),
  updatedAt: z.number().finite().optional(),
  createdAt: createdAtSchema,
});
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;
export type QueuedMessageInput = z.input<typeof queuedMessageSchema>;

export const historyRowSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["KT", "legacy"]),
  title: z.string().min(1),
  preview: z.string(),
  updatedAt: z.string().min(1),
  messageCount: z.number().int().nonnegative(),
});
export type HistoryRow = z.infer<typeof historyRowSchema>;

export const windowLayoutSchema = z.object({
  left: z.number().finite(),
  top: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});
export type WindowLayout = z.infer<typeof windowLayoutSchema>;

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const profileProtocolSchema = z.enum(["gemini-native", "openai-chat-completions"]);
export type ProfileProtocol = z.infer<typeof profileProtocolSchema>;

export const profileRuntimeSchema = z.enum(["remote-http", "llama-endpoint", "llama-once"]);
export type ProfileRuntime = z.infer<typeof profileRuntimeSchema>;

export const profileCapabilitiesSchema = z.object({
  tools: z.boolean(),
  vision: z.boolean(),
  streaming: z.boolean(),
  reasoning: z.boolean(),
});
export type ProfileCapabilities = z.infer<typeof profileCapabilitiesSchema>;

export const profileParametersSchema = z.object({
  temperature: z.number().min(0).max(2),
  topP: z.number().min(0).max(1),
  maxTokens: z.number().int().positive(),
  reasoningEffort: z.string().min(1),
  timeout: z.number().int().positive(),
  sanitizeSensitive: z.boolean(),
  teacherMode: z.string().min(1),
});
export type ProfileParameters = z.infer<typeof profileParametersSchema>;

export const profileModelInfoSchema = z.object({
  source: z.string(),
  providerId: z.string(),
  matchedModelId: z.string(),
  contextLimit: z.number().int().nonnegative(),
  outputLimit: z.number().int().nonnegative(),
  temperatureSupported: z.boolean(),
  reasoningToggle: z.boolean(),
  reasoningEfforts: z.array(z.string()),
  syncedAt: z.string(),
});
export type ProfileModelInfo = z.infer<typeof profileModelInfoSchema>;

export const profileSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  modelId: z.string().min(1),
  enabled: z.boolean(),
  protocol: profileProtocolSchema,
  runtime: profileRuntimeSchema,
  endpoint: z.string(),
  fallbackEndpoints: z.array(z.string()),
  apiKey: z.string(),
  hasApiKey: z.boolean(),
  capabilities: profileCapabilitiesSchema,
  parameters: profileParametersSchema,
  modelInfo: profileModelInfoSchema,
  modelPath: z.string(),
  mmprojPath: z.string(),
  llamaServerPath: z.string(),
  nCtx: z.number().int().positive(),
  nGpuLayers: z.number().int(),
  thinking: z.boolean(),
});
export type Profile = z.infer<typeof profileSchema>;

export const profilePatchSchema = z.object({
  displayName: z.string().optional(),
  modelId: z.string().optional(),
  enabled: z.boolean().optional(),
  protocol: profileProtocolSchema.optional(),
  runtime: profileRuntimeSchema.optional(),
  endpoint: z.string().optional(),
  fallbackEndpoints: z.array(z.string()).optional(),
  apiKey: z.string().optional(),
  hasApiKey: z.boolean().optional(),
  capabilities: profileCapabilitiesSchema.partial().optional(),
  parameters: profileParametersSchema.partial().optional(),
  modelInfo: profileModelInfoSchema.partial().optional(),
  modelPath: z.string().optional(),
  mmprojPath: z.string().optional(),
  llamaServerPath: z.string().optional(),
  nCtx: z.number().int().positive().optional(),
  nGpuLayers: z.number().int().optional(),
  thinking: z.boolean().optional(),
});
export type ProfilePatch = z.infer<typeof profilePatchSchema>;

export const profileStateSchema = z.object({
  version: z.literal(2),
  activeProfileId: z.string(),
  teacherProfileId: z.string(),
  sessionProfileId: z.string(),
  namingProfileId: z.string(),
  profiles: z.array(profileSchema).min(1),
});
export type ProfileState = z.infer<typeof profileStateSchema>;

export const profileStateInputSchema = z.object({
  version: z.number().int().optional(),
  activeProfileId: z.string().optional(),
  active_profile_id: z.string().optional(),
  teacherProfileId: z.string().optional(),
  teacher_profile_id: z.string().optional(),
  sessionProfileId: z.string().optional(),
  session_profile_id: z.string().optional(),
  namingProfileId: z.string().optional(),
  naming_profile_id: z.string().optional(),
  profiles: z.array(z.unknown()).optional(),
}).passthrough();
export type ProfileStateInput = z.infer<typeof profileStateInputSchema>;

export interface ProfileStoreActionContracts {
  reload(): void;
  setState(state: unknown): void;
  setProfiles(profiles: Profile[]): void;
  upsertProfile(profile: Profile): void;
  selectProfile(profileId: string): void;
  addProfile(seed?: Partial<Profile>): Profile;
  duplicateProfile(profileId: string): Profile | null;
  updateProfile(profileId: string, patch: ProfilePatch): Profile | null;
  deleteProfile(profileId: string): boolean;
  activateProfile(profileId: string): void;
  setTeacherProfile(profileId: string): void;
  setSessionProfile(profileId: string): void;
  setNamingProfile(profileId: string): void;
  restoreDefaults(): void;
  reset(): void;
}

export interface ProfileActionHandlers {
  testConnection(profile: Profile): void | Promise<void>;
  syncModelsDev(profile: Profile): void | Promise<ProfilePatch | { patch: ProfilePatch } | void>;
  addProfile?(seed?: Partial<Profile>): Profile | null;
  duplicateProfile?(profileId: string): Profile | null;
  updateProfile?(profileId: string, patch: ProfilePatch): Profile | null;
  deleteProfile?(profileId: string): boolean;
  activateProfile?(profileId: string): void;
  setTeacherProfile?(profileId: string): void;
  setSessionProfile?(profileId: string): void;
  setNamingProfile?(profileId: string): void;
  restoreDefaults?(): void;
}

export interface SendMessageInput {
  text: string;
  attachments: WireAttachment[];
  displayAttachments?: ChatAttachment[];
  reasoning: ReasoningEffort;
  editOf?: string;
}

export interface BranchTurn {
  turnIndex: number;
  branches: number[];
  branchCount: number;
  latestBranch?: number;
  selectedBranchId?: number;
  branchStatuses?: Record<string, string>;
  userGroups?: Array<{ content: string; branches: number[] }>;
  selectedUserGroupIndex?: number;
}

export interface BranchMetadata {
  session_id?: string;
  branch_view: Record<string, number>;
  selected_branch_ids?: Record<string, number>;
  branch_counts?: Record<string, number>;
  latest_branch_ids?: Record<string, number>;
  branch_statuses?: Record<string, Record<string, string>>;
  turns?: BranchTurn[];
  final_turn_index?: number | null;
  [key: string]: unknown;
}

export interface LegacySessionRecord {
  session_id: string;
  title?: string;
  preview?: string;
  updated_at?: string | number;
  message_count?: number;
  [key: string]: unknown;
}

export interface RuntimeSession {
  session_id: string;
  profile_id?: string;
  [key: string]: unknown;
}

export interface MessageSubmission {
  kind: "turn" | "queued" | "edit" | "local";
  id?: string;
}

export interface LoomActionHandlers {
  sendMessage(input: SendMessageInput): MessageSubmission | void | Promise<MessageSubmission | void>;
  stopRequest(): void;
  attachFiles(files: File[]): ChatAttachment[] | void | Promise<ChatAttachment[] | void>;
  replaceAttachment(id: string, file: File): ChatAttachment | void | Promise<ChatAttachment | void>;
  removeAttachment(id: string): void | Promise<void>;
  readPrompt(): void | Promise<void>;
  clearChat(): void;
  copyMessage(message: ChatMessage): void | Promise<void>;
  regenerate(message: ChatMessage): void | Promise<void>;
  undoToolMutation(message: ChatMessage): void | Promise<void>;
  changeBranch(message: ChatMessage, branchIndex: number): void | Promise<void>;
  removeQueuedMessage(id: string): void | Promise<void>;
  selectHistory(row: HistoryRow): void | Promise<void>;
  newSession(): void | Promise<void>;
  openSettings(): void;
  retryQueuedMessage?(id: string): void | Promise<void>;
  editQueuedMessage?(id: string, input: SendMessageInput): void | Promise<void>;
}

export const ktEventSchema = z.object({
  id: z.string().optional(),
  event: z.string().min(1),
  data: z.unknown(),
  rawData: z.string(),
  sequence: z.number().int().nonnegative().optional(),
});
export type KTEvent = z.infer<typeof ktEventSchema>;

export function parseBoundary<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`${label} boundary validation failed: ${result.error.message}`);
  }
  return result.data;
}
