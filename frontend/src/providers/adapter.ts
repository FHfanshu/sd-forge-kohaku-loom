import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ModelCapabilities, ProviderCapability } from "./capabilities";
import { createPromptAgentStream, type StreamRetryNotice } from "./proxy-stream";
import { toPromptAgentModel } from "./proxy-model";

export interface ProviderProfileMetadata {
  id?: string;
  providerId?: string;
  protocol?: string;
  runtime?: string;
  endpoint?: string;
  modelInfo?: { providerId?: string };
  capabilities?: Partial<ModelCapabilities>;
}

export interface ProviderModel {
  id: string;
  profileId?: string;
  providerId: string;
  displayName: string;
  capabilities: ModelCapabilities;
  contextWindow: number;
  maxTokens: number;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  matches(profile: ProviderProfileMetadata): boolean;
  toPiModel(model: ProviderModel): Model<any>;
  createStream(profileId: string, turnId?: () => string, onRetry?: (notice: StreamRetryNotice) => void): StreamFn;
  stream(model: Model<any>, context: Context, options?: SimpleStreamOptions): ReturnType<StreamFn>;
  effectiveCapabilities(profile: ProviderProfileMetadata): ModelCapabilities;
  unsupportedCapabilities(profile: ProviderProfileMetadata): ProviderCapability[];
}

export function createProviderAdapter(
  id: string,
  capabilities: ModelCapabilities,
  matches: (profile: ProviderProfileMetadata) => boolean,
  capabilitiesForProfile: (profile: ProviderProfileMetadata) => ModelCapabilities = () => capabilities,
): ProviderAdapter {
  const createStream = (
    profileId: string,
    turnId: () => string = () => "",
    onRetry?: (notice: StreamRetryNotice) => void,
  ): StreamFn => createPromptAgentStream(() => profileId, undefined, fetch, turnId, onRetry);
  const modelProfileIds = new WeakMap<object, string>();
  const effectiveCapabilities = (profile: ProviderProfileMetadata): ModelCapabilities => {
    const declared = profile.capabilities ?? {};
    const keys: Array<keyof ModelCapabilities> = ["streaming", "tools", "vision", "reasoning", "attachments", "systemPrompt", "usage", "abort"];
    const effective = { ...capabilitiesForProfile(profile) };
    for (const key of keys) {
      if (declared[key] === false) effective[key] = false;
    }
    return effective;
  };
  return {
    id,
    capabilities,
    matches,
    toPiModel: (model) => {
      const result = toPromptAgentModel({ ...model, providerId: id });
      if (model.profileId) modelProfileIds.set(result, model.profileId);
      return result;
    },
    createStream,
    stream: (model, context, options) => createStream(modelProfileIds.get(model) ?? model.id)(model, context, options),
    effectiveCapabilities,
    unsupportedCapabilities: (profile) => {
      const effective = effectiveCapabilities(profile);
      const keys: Array<keyof ModelCapabilities> = ["streaming", "tools", "vision", "reasoning", "attachments", "systemPrompt", "usage", "abort"];
      return keys.filter((key) => effective[key] === false);
    },
  };
}
