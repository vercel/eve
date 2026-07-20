import type { ContextAccessor } from "#context/key.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { CancelTurnResult, Runtime } from "#channel/types.js";
import type { SessionAuth } from "#context/keys.js";
import { AuthKey, ContinuationTokenKey, InitiatorAuthKey, SessionIdKey } from "#context/keys.js";

/**
 * Result of starting or delivering to a session. Exposes the session
 * `id`, its channel-local `continuationToken`, and `getEventStream`, which
 * resolves to a `ReadableStream` of the session's harness events
 * (optionally from `startIndex`). Returned by {@link SendFn},
 * {@link GetSessionFn}, and a channel's `receive` hook. Unlike the live
 * {@link SessionHandle} on `ctx.session`, this is an inert result value:
 * its fields are snapshots and it cannot mutate the continuation token.
 */
export interface Session {
  readonly id: string;
  readonly continuationToken: string;
  /**
   * Requests cancellation of this session's in-flight turn. `turnId` limits
   * the request to the turn the caller observed. Both statuses are
   * successful; confirmation is `turn.cancelled` followed by
   * `session.waiting` on the event stream.
   */
  cancel(options?: { turnId?: string }): Promise<CancelTurnResult>;
  /**
   * Opens the durable event stream. Negative start indexes read relative to
   * the current tail (`-1` starts at the latest event).
   */
  getEventStream(options?: {
    startIndex?: number;
  }): Promise<ReadableStream<HandleMessageStreamEvent>>;
}

/**
 * Live handle to the current session, exposed on `ctx.session` to
 * `deliver` and event handlers. The framework hydrates the read-only
 * fields from the active context at step start. A write through
 * {@link SessionHandle.setContinuationToken} updates the context so the
 * runtime can re-key the parked workflow hook at the next step boundary.
 */
export interface SessionHandle {
  readonly id: string;
  readonly continuationToken: string;
  readonly auth: SessionAuth;
  setContinuationToken(rawToken: string): void;
}

export function createSession(id: string, continuationToken: string, runtime: Runtime): Session {
  return {
    id,
    continuationToken,
    async cancel(options?: { turnId?: string }) {
      return runtime.cancelTurn({ sessionId: id, turnId: options?.turnId });
    },
    async getEventStream(options?: { startIndex?: number }) {
      return runtime.getEventStream(id, options);
    },
  };
}

export function createGetSessionFn(runtime: Runtime): (sessionId: string) => Session {
  return (sessionId: string) => createSession(sessionId, "", runtime);
}

/**
 * Builds a live {@link SessionHandle} backed by the active context
 * accessor. Read-only fields resolve through getters so they reflect
 * any updates made by other handlers within the same step (e.g. the
 * `deliver` hook seeding `AuthKey` before an event handler reads
 * `session.auth`).
 *
 * Used by {@link buildAdapterContext} to populate `ctx.session` on
 * every adapter handler invocation.
 */
export function buildSessionHandle(accessor: ContextAccessor): SessionHandle {
  return {
    get id() {
      return accessor.get(SessionIdKey) ?? "";
    },
    get continuationToken() {
      return accessor.get(ContinuationTokenKey) ?? "";
    },
    get auth(): SessionAuth {
      return {
        current: accessor.get(AuthKey) ?? null,
        initiator: accessor.get(InitiatorAuthKey) ?? null,
      };
    },
    setContinuationToken(rawToken: string): void {
      const currentToken = accessor.get(ContinuationTokenKey) ?? "";
      const token = namespaceContinuationToken(currentToken, rawToken);

      // Idempotent: a redundant write would push the workflow body
      // through a hook dispose / recreate cycle for no reason. The
      // call must remain cheap so channels can call it from
      // hot-path event handlers without measuring first.
      if (currentToken === token) return;
      accessor.set(ContinuationTokenKey, token);
    },
  };
}

function namespaceContinuationToken(currentToken: string, rawToken: string): string {
  const separatorIndex = currentToken.indexOf(":");
  if (separatorIndex <= 0) {
    throw new Error(
      "Cannot set session continuation token without an existing namespaced " +
        "continuation token. Start the session with a placeholder continuationToken.",
    );
  }
  return `${currentToken.slice(0, separatorIndex + 1)}${rawToken}`;
}
