import { createStore } from "./store";
import type { HistoryRow, RuntimeSession } from "../contracts";

export type WorkingPhase = "idle" | "submitting" | "thinking" | "generating" | "retrying" | "tool" | "cancelling";
export type RuntimeStartupState = "idle" | "starting" | "ready" | "error";

export interface RuntimeStore {
  sessionId: string | null;
  session: RuntimeSession | null;
  history: HistoryRow[];
  loading: boolean;
  startup: RuntimeStartupState;
  workingPhase: WorkingPhase;
  workingTool: string | null;
  workingDetail: string | null;
  error: string | null;
  setSession(session: RuntimeSession | null): void;
  setHistory(history: HistoryRow[]): void;
  setLoading(loading: boolean): void;
  setStartup(startup: RuntimeStartupState): void;
  setWorking(phase: WorkingPhase, detail?: string | null): void;
  setError(error: string | null): void;
  reset(): void;
}

export const useRuntimeStore = createStore<RuntimeStore>((set) => ({
  sessionId: null,
  session: null,
  history: [],
  loading: false,
  startup: "idle",
  workingPhase: "idle",
  workingTool: null,
  workingDetail: null,
  error: null,
  setSession(session) {
    set({ session, sessionId: session?.session_id ?? null });
  },
  setHistory(history) {
    set({ history });
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
  reset() {
    set({
      sessionId: null,
      session: null,
      history: [],
      loading: false,
      startup: "idle",
      workingPhase: "idle",
      workingTool: null,
      workingDetail: null,
      error: null,
    });
  },
}));
