import type { PromptAgentNamespace } from "./bridge";

declare global {
  interface Window {
    __SD_FORGE_NEO_PROMPT_AGENT__?: PromptAgentNamespace;
  }
}

export {};
