import type { AgentRuntimeState } from "./runtime-state";

export type RuntimeListener = (state: AgentRuntimeState) => void;
