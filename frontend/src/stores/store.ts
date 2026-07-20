import { writable, type Readable } from "svelte/store";

export type StorePatch<T> = Partial<T> | ((state: T) => Partial<T>);
export type StoreSetter<T> = (patch: StorePatch<T>) => void;
export type StoreGetter<T> = () => T;

export interface PromptAgentStore<T> extends Readable<T> {
  getState(): T;
  setState(patch: StorePatch<T>): void;
}

export function createStore<T>(
  initialize: (set: StoreSetter<T>, get: StoreGetter<T>) => T,
): PromptAgentStore<T> {
  let current!: T;
  const source = writable<T>(undefined as T);
  const setState: StoreSetter<T> = (patch) => {
    const next = typeof patch === "function" ? patch(current) : patch;
    current = { ...current, ...next };
    source.set(current);
  };
  current = initialize(setState, () => current);
  source.set(current);
  return {
    subscribe: source.subscribe,
    getState: () => current,
    setState,
  };
}
