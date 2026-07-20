export interface ModelCapabilities {
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  attachments: boolean;
  systemPrompt: boolean;
  usage?: boolean;
  abort?: boolean;
}

export type ProviderCapability = keyof ModelCapabilities;

export const allProviderCapabilities = (): ModelCapabilities => ({
  streaming: true,
  tools: true,
  vision: true,
  reasoning: true,
  attachments: true,
  systemPrompt: true,
  usage: true,
  abort: true,
});
