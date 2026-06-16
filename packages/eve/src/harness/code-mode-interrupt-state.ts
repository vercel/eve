import type { ModelMessage } from "ai";

import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import type { CodeModeInterrupt } from "#shared/code-mode.js";

const PENDING_KEY = "eve.harness.pendingCodeModeInterrupt";

/**
 * One code-mode invocation parked on a host interrupt (nested-tool approval,
 * connection auth, or any future durable interrupt kind), plus the assistant
 * response messages that produced the outer `code_mode` tool result.
 *
 * Every interrupt kind rides this single pending slot; the kind-specific
 * behavior lives in {@link parkOnCodeModeInterrupt} /
 * {@link continuePendingCodeModeInterrupt}, keyed by `interrupt.payload.kind`.
 */
export interface PendingCodeModeInterrupt {
  readonly interrupt: CodeModeInterrupt;
  readonly responseMessages: readonly ModelMessage[];
}

/** Returns the pending code-mode interrupt stored on the session, if any. */
export function getPendingCodeModeInterrupt(
  state: SessionStateMap | undefined,
): PendingCodeModeInterrupt | undefined {
  const value = state?.[PENDING_KEY];
  if (!isRecord(value)) return undefined;
  if (!isCodeModeInterruptShape(value.interrupt) || !Array.isArray(value.responseMessages)) {
    return undefined;
  }
  return {
    interrupt: value.interrupt,
    responseMessages: value.responseMessages as ModelMessage[],
  };
}

/** Stores one pending code-mode interrupt on the session. */
export function setPendingCodeModeInterrupt(input: {
  readonly interrupt: CodeModeInterrupt;
  readonly responseMessages: readonly ModelMessage[];
  readonly session: HarnessSession;
}): HarnessSession {
  return {
    ...input.session,
    state: {
      ...input.session.state,
      [PENDING_KEY]: {
        interrupt: input.interrupt,
        responseMessages: input.responseMessages,
      } satisfies PendingCodeModeInterrupt,
    },
  };
}

/** Clears any pending code-mode interrupt from the session. */
export function clearPendingCodeModeInterrupt(session: HarnessSession): HarnessSession {
  if (session.state?.[PENDING_KEY] === undefined) {
    return session;
  }

  const state = { ...session.state };
  delete state[PENDING_KEY];

  return {
    ...session,
    state: Object.keys(state).length > 0 ? state : undefined,
  };
}

// Loose structural guard for our own persisted interrupt. The package's full
// `isCodeModeInterrupt` additionally verifies the signed continuation and
// ledger; that check belongs on resume (`continueCodeModeInterrupt`), not on
// reading state we wrote ourselves.
function isCodeModeInterruptShape(value: unknown): value is CodeModeInterrupt {
  return (
    isRecord(value) &&
    value.type === "code-mode-interrupt" &&
    typeof value.interruptId === "string" &&
    typeof value.outerToolCallId === "string" &&
    isRecord(value.payload) &&
    typeof value.payload.kind === "string" &&
    isRecord(value.continuation) &&
    typeof value.continuation.outerToolCallId === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
