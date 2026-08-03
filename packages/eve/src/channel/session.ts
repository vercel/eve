import type { UserContent } from "ai";

import type { ContextAccessor } from "#context/key.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type {
  CancelTurnResult,
  ClearSessionResult,
  CompactSessionResult,
  ResetSessionCommandResult,
  Runtime,
  SessionAuthContext,
  SessionSendCommandResult,
} from "#channel/types.js";
import type { SendPayload } from "#channel/routes.js";
import { normalizeSendInput, serializeUrlFilePartsInMessage } from "#channel/send-input.js";
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
  getEventStream(options?: { startIndex?: number }): Promise<ReadableStream<MessageStreamEvent>>;
  /**
   * Resolves the durable tail of the event stream: the zero-based index of
   * the last recorded event, or `-1` before the first.
   */
  getStreamTailIndex(): Promise<number>;
}

/** Immutable-ID session handle for aligned send, control, and stream operations. */
export interface FixedSession {
  readonly id: string;
  /** Sends input to this exact session ID without creating or following a replacement. */
  send(
    input: string | UserContent | SendPayload,
    options: SessionSendOptions,
  ): Promise<SessionSendCommandResult>;
  /** Requests cancellation of this exact session's active turn. */
  cancel(options?: { turnId?: string }): Promise<CancelTurnResult>;
  /** Queues compaction on this exact session ID. */
  compact(): Promise<CompactSessionResult>;
  /** Queues a context clear on this exact session ID. */
  clear(): Promise<ClearSessionResult>;
  /** Terminally retires this exact session ID. */
  reset(options?: { reason?: string }): Promise<ResetSessionCommandResult>;
  getEventStream(options?: { startIndex?: number }): Promise<ReadableStream<MessageStreamEvent>>;
  getStreamTailIndex(): Promise<number>;
}

/** Per-delivery metadata required when sending through a fixed session handle. */
export interface SessionSendOptions {
  readonly auth: SessionAuthContext | null;
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

export function createSession(
  id: string,
  continuationToken: string,
  runtime: Runtime,
  metadata: { readonly requestId?: string } = {},
): Session & FixedSession {
  return {
    id,
    continuationToken,
    async send(input, options) {
      const payload = normalizeSendInput(input);
      return await runtime.dispatchSession({
        command: {
          auth: options.auth,
          kind: "send",
          payload: {
            ...payload,
            message: serializeUrlFilePartsInMessage(payload.message),
          },
          requestId: metadata.requestId,
        },
        sessionId: id,
      });
    },
    async cancel(options?: { turnId?: string }) {
      return await runtime.dispatchSession({
        command: { kind: "cancel", turnId: options?.turnId },
        sessionId: id,
      });
    },
    async compact() {
      return await runtime.dispatchSession({ command: { kind: "compact" }, sessionId: id });
    },
    async clear() {
      return await runtime.dispatchSession({ command: { kind: "clear" }, sessionId: id });
    },
    async reset(options) {
      return await runtime.dispatchSession({
        command: { kind: "reset", reason: options?.reason },
        sessionId: id,
      });
    },
    async getEventStream(options?: { startIndex?: number }) {
      return runtime.getEventStream(id, options);
    },
    async getStreamTailIndex() {
      return runtime.getStreamTailIndex(id);
    },
  };
}

export function createGetSessionFn(
  runtime: Runtime,
  metadata: { readonly requestId?: string } = {},
): (sessionId: string) => Session {
  return (sessionId: string) => createSession(sessionId, "", runtime, metadata);
}

/** Builds an I/O-free factory for fixed session-ID handles. */
export function createAttachSessionFn(
  runtime: Runtime,
  metadata: { readonly requestId?: string } = {},
): (sessionId: string) => FixedSession {
  return (sessionId) => createSession(sessionId, "", runtime, metadata);
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
