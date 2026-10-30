import {
  DURABLE_SESSION_VERSION,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { positionState } from "#internal/testing/session-machine.js";

/**
 * Complete session checkpoint for tests that exercise workflow coordination. `position` seeds the
 * projection: inside an open turn, or between turns when `turnId` is empty.
 */
export function createTestSessionState(
  overrides: Partial<DurableSessionState> = {},
  position?: { readonly sequence: number; readonly stepIndex?: number; readonly turnId: string },
): DurableSessionState {
  return {
    continuationToken: overrides.continuationToken ?? "test-token",
    sessionId: overrides.sessionId ?? "test-session",
    hasProxyInputRequests: false,
    version: DURABLE_SESSION_VERSION,
    snapshot: {
      session: {
        agent: { system: "" },
        continuationToken: overrides.continuationToken ?? "test-token",
        sessionId: overrides.sessionId ?? "test-session",
        ...(position !== undefined && { state: positionState(position) }),
      },
    },
    ...overrides,
  };
}
