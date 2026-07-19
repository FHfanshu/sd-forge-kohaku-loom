import { createStore } from "./store";
import type { BranchMetadata, HistoryRow, RuntimeSession } from "../contracts";

export type WorkingPhase = "idle" | "submitting" | "thinking" | "generating" | "retrying" | "tool" | "cancelling";
export type RuntimeStartupState = "idle" | "starting" | "ready" | "error";

export interface RuntimeStore {
  sessionId: string | null;
  session: RuntimeSession | null;
  history: HistoryRow[];
  branches: BranchMetadata | null;
  queuePaused: boolean;
  loading: boolean;
  startup: RuntimeStartupState;
  workingPhase: WorkingPhase;
  workingTool: string | null;
  workingDetail: string | null;
  error: string | null;
  legacySessionId: string | null;
  setSession(session: RuntimeSession | null): void;
  setHistory(history: HistoryRow[]): void;
  setBranches(branches: BranchMetadata | null): void;
  setQueuePaused(queuePaused: boolean): void;
  setLoading(loading: boolean): void;
  setStartup(startup: RuntimeStartupState): void;
  setWorking(phase: WorkingPhase, detail?: string | null): void;
  setError(error: string | null): void;
  setLegacySession(sessionId: string | null): void;
  reset(): void;
}

export const useRuntimeStore = createStore<RuntimeStore>((set) => ({
  sessionId: null,
  session: null,
  history: [],
  branches: null,
  queuePaused: false,
  loading: false,
  startup: "idle",
  workingPhase: "idle",
  workingTool: null,
  workingDetail: null,
  error: null,
  legacySessionId: null,
  setSession(session) {
    set({ session, sessionId: session?.session_id ?? null, legacySessionId: null });
  },
  setHistory(history) {
    set({ history });
  },
  setBranches(branches) {
    set({ branches });
  },
  setQueuePaused(queuePaused) {
    set({ queuePaused });
  },
  setLoading(loading) {
    set({ loading });
  },
  setStartup(startup) {
    set({ startup });
  },
  setWorking(workingPhase, detail = null) {
    set({
      workingPhase,
      workingTool: workingPhase === "tool" ? detail : null,
      workingDetail: workingPhase === "retrying" ? detail : null,
    });
  },
  setError(error) {
    set({ error });
  },
  setLegacySession(legacySessionId) {
    set({ legacySessionId, sessionId: null, session: null });
  },
  reset() {
    set({
      sessionId: null,
      session: null,
      history: [],
      branches: null,
      queuePaused: false,
      loading: false,
      startup: "idle",
      workingPhase: "idle",
      workingTool: null,
      workingDetail: null,
      error: null,
      legacySessionId: null,
    });
  },
}));
