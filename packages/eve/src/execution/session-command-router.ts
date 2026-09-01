import { reportDroppedWirePayloadStep } from "#execution/report-dropped-wire-payload-step.js";
import type { SessionInboxPayload } from "#execution/session-command-inbox.js";
import {
  sessionInboxWire,
  SessionInboxWireError,
  type DecodedSessionInbox,
} from "#execution/wire/session-inbox-wire.js";

/** Routes raw session-inbox payloads at the workflow-driver boundary. */
export interface SessionCommandRouter {
  route(payload: SessionInboxPayload): Promise<DecodedSessionInbox | undefined>;
}

/**
 * Creates the driver-owned router for versioned session commands. A stale or
 * invalid payload returns undefined.
 */
export function createSessionCommandRouter(): SessionCommandRouter {
  return {
    async route(payload): Promise<DecodedSessionInbox | undefined> {
      // Runtime-action results use the active turn's private inbox. A late
      // value can still surface through a retired session alias.
      if (payload.kind === "runtime-action-result") return undefined;

      try {
        return sessionInboxWire.decode(payload);
      } catch (error) {
        if (!(error instanceof SessionInboxWireError)) throw error;
        await reportDroppedWirePayloadStep({ detail: error.message, family: "session-inbox" });
        return undefined;
      }
    },
  };
}
