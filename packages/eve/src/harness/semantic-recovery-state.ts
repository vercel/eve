import type { HarnessSession, SessionStateMap } from "#harness/types.js";

export interface PendingSemanticRecovery {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly semanticErrorId: string;
  readonly turnId: string;
}

const SEMANTIC_RECOVERY_STATE_KEY = "eve.harness.semanticRecovery";

export function getPendingSemanticRecovery(
  state: SessionStateMap | undefined,
): PendingSemanticRecovery | undefined {
  const value = state?.[SEMANTIC_RECOVERY_STATE_KEY];
  if (!isPendingSemanticRecovery(value)) return undefined;
  return value;
}

export function nextSemanticRecoveryAttempt(input: {
  readonly semanticErrorId: string;
  readonly state: SessionStateMap | undefined;
  readonly turnId: string;
  readonly maxAttempts: number;
}): number | undefined {
  const pending = getPendingSemanticRecovery(input.state);
  if (pending?.turnId === input.turnId && pending.semanticErrorId === input.semanticErrorId) {
    return pending.attempt < input.maxAttempts ? pending.attempt + 1 : undefined;
  }
  return 1;
}

export function setPendingSemanticRecovery(
  session: HarnessSession,
  recovery: PendingSemanticRecovery,
): HarnessSession {
  return {
    ...session,
    state: { ...session.state, [SEMANTIC_RECOVERY_STATE_KEY]: recovery },
  };
}

export function clearPendingSemanticRecovery(session: HarnessSession): HarnessSession {
  if (session.state?.[SEMANTIC_RECOVERY_STATE_KEY] === undefined) return session;
  const { [SEMANTIC_RECOVERY_STATE_KEY]: _, ...state } = session.state;
  return { ...session, state };
}

function isPendingSemanticRecovery(value: unknown): value is PendingSemanticRecovery {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.semanticErrorId === "string" &&
    candidate.semanticErrorId.length > 0 &&
    typeof candidate.turnId === "string" &&
    candidate.turnId.length > 0 &&
    isPositiveSafeInteger(candidate.attempt) &&
    isPositiveSafeInteger(candidate.maxAttempts) &&
    candidate.attempt <= candidate.maxAttempts
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
