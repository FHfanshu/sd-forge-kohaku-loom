import { PromptAgentController } from "./agent/controller";

export function createPromptAgentController(): PromptAgentController {
  return new PromptAgentController();
}

export async function connectPromptAgentController(signal?: AbortSignal): Promise<PromptAgentController> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return createPromptAgentController();
}
