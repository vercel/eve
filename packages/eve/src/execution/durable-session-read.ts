import type { DurableSession, DurableSessionState } from "#execution/durable-session-store.js";

// Workflow bodies read checkpoints, so the reader stays free of the store's runtime imports.

/** Explicit checkpoint contract shared by deployment handoffs. */
export const DURABLE_SESSION_VERSION = 2;

/** Reads only the embedded checkpoint; no stream or migration fallback exists. */
export function readDurableSession(state: DurableSessionState): DurableSession {
  if (state.version !== DURABLE_SESSION_VERSION || state.snapshot?.session === undefined) {
    throw new Error("Unsupported session checkpoint. Start a new session on this deployment.");
  }
  return state.snapshot.session;
}
