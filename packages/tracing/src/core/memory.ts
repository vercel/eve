import type { Attributes } from "./types.js";

export interface MemoryToolStore {
  readonly storeId: string;
  readonly slot: string;
}

/** Names the memory store a tool call reads or writes, matching the memory operation spans. */
export interface MemoryToolLifecycle {
  store(input: MemoryToolStore): void;
}

export function memoryToolLifecycle(write: (attributes: Attributes) => void): MemoryToolLifecycle {
  return {
    store({ storeId, slot }) {
      write({ "gen_ai.memory.store.id": storeId, "agent.memory.slot": slot });
    },
  };
}
