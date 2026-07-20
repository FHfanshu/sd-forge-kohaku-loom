import type { Profile } from "../contracts";
import type { ModelCapabilities, ProviderCapability } from "./capabilities";
import { providerRegistry } from "./registry";

const profileMetadata = (profile: Profile) => ({
  id: profile.id,
  providerId: profile.providerId || profile.modelInfo.providerId,
  protocol: profile.protocol,
  runtime: profile.runtime,
  endpoint: profile.endpoint,
  modelInfo: { providerId: profile.modelInfo.providerId },
  capabilities: profile.capabilities,
});

export function effectiveProfileCapabilities(profile: Profile): ModelCapabilities {
  return providerRegistry.resolve(profileMetadata(profile)).effectiveCapabilities(profileMetadata(profile));
}

export function unsupportedProfileCapabilities(profile: Profile): ProviderCapability[] {
  return providerRegistry.resolve(profileMetadata(profile)).unsupportedCapabilities(profileMetadata(profile));
}

export function supportsAgentChat(profile: Profile): boolean {
  try {
    return effectiveProfileCapabilities(profile).streaming;
  } catch {
    return false;
  }
}
