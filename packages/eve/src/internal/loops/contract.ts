import type { Runtime } from "#channel/types.js";

export type LoopKind = "inline" | "workflow" | "temporal";

/** One selected implementation bound to a compiled-artifact generation. */
export interface LoopDriver {
  readonly kind: LoopKind;
  close(): Promise<void>;
  createRuntime(input?: { readonly nodeId?: string }): Runtime;
}
