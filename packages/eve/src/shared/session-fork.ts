import type { ModelMessage } from "ai";
import type { SessionHistoryMessage } from "#shared/session-history.js";

export interface SessionForkSeed {
  readonly source: { readonly sessionId: string };
  readonly messages: readonly ModelMessage[];
  readonly transcript: readonly SessionHistoryMessage[];
}
