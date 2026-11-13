/**
 * Typed eve tool fixtures for unit tests, built against eve's public tool
 * types so fixture drift after an eve upgrade fails typecheck.
 *
 * @packageDocumentation
 */
import type { ToolContext } from "eve/tools";

const unsupported = (name: string) => (): never => {
  throw new Error(`This test does not provide ${name}.`);
};

/**
 * Builds the context eve passes to a tool's `execute`.
 *
 * @param toolName - Runtime name of the tool under test.
 * @returns A root-session context whose sandbox and auth accessors fail when unexpectedly called.
 */
export const toolContext = (toolName: string): ToolContext => ({
  abortSignal: new AbortController().signal,
  callId: "call_1",
  getSandbox: unsupported("a session sandbox"),
  getToken: unsupported("tool auth tokens"),
  messages: [],
  requireAuth: unsupported("tool authorization"),
  session: {
    auth: { current: null, initiator: null },
    id: "session_1",
    turn: { id: "turn_1", sequence: 1 },
  },
  toolName,
});
