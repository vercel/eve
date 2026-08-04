import type { ContextAccessor } from "#context/key.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type {
  CancelTurnResult,
  ClearSessionResult,
  CompactSessionResult,
  ResetSessionResult,
  Runtime,
  SessionAuthContext,
  SessionSendCommandResult,
} from "#channel/types.js";
import type { SendPayload } from "#channel/routes.js";
import { normalizeSendInput, serializeUrlFilePartsInMessage } from "#channel/send-input.js";
import type { SessionAuth } from "#context/keys.js";
import { AuthKey, ContinuationTokenKey, InitiatorAuthKey, SessionIdKey } from "#context/keys.js";

/** Immutable-ID handle for one exact durable session. */
export interface Session {
  readonly id: string;
  /** Sends input to this exact session ID without creating or following a replacement. */
  send(input: SessionSendInput): Promise<SessionSendCommandResult>;
  /** Requests cancellation of this exact session's active turn. */
  cancel(options?: { turnId?: string }): Promise<CancelTurnResult>;
  /** Queues compaction on this exact session ID. */
  compact(): Promise<CompactSessionResult>;
  /** Queues a context clear on this exact session ID. */
  clear(): Promise<ClearSessionResult>;
  /** Terminally retires this exact session ID. */
  reset(options?: { reason?: string }): Promise<ResetSessionResult>;
  getEventStream(options?: { startIndex?: number }): Promise<ReadableStream<MessageStreamEvent>>;
  getStreamTailIndex(): Promise<number>;
}

/** Message and authorization for delivery through a fixed session handle. */
export interface SessionSendInput extends SendPayload {
  readonly auth: SessionAuthContext | null;
}

/**
 * Live handle to the current session, exposed on `ctx.session` to
 * `deliver` and event handlers. The framework hydrates the read-only
 * fields from the active context at step start. A write through
 * `continuation.rekey()` updates the context so the
 * runtime can re-key the parked workflow hook at the next step boundary.
 */
export interface SessionHandle {
  readonly id: string;
  readonly auth: SessionAuth;
  readonly continuation?: {
    readonly token: string;
    rekey(rawToken: string): void;
  };
}

export function createSession(
  id: string,
  runtime: Runtime,
  metadata: { readonly requestId?: string } = {},
): Session {
  return {
    id,
    async send(input) {
      const { auth, ...sendInput } = input;
      const payload = normalizeSendInput(sendInput);
      return await runtime.dispatchSession({
        command: {
          auth,
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

/** Builds an I/O-free factory for fixed session-ID handles. */
export function createAttachSessionFn(
  runtime: Runtime,
  metadata: { readonly requestId?: string } = {},
): (sessionId: string) => Session {
  return (sessionId) => createSession(sessionId, runtime, metadata);
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
    get auth(): SessionAuth {
      return {
        current: accessor.get(AuthKey) ?? null,
        initiator: accessor.get(InitiatorAuthKey) ?? null,
      };
    },
    get continuation() {
      const currentToken = accessor.get(ContinuationTokenKey);
      if (currentToken === undefined || currentToken.length === 0) return undefined;
      return {
        token: currentToken,
        rekey(rawToken: string): void {
          const token = namespaceContinuationToken(currentToken, rawToken);
          if (currentToken === token) return;
          accessor.set(ContinuationTokenKey, token);
        },
      };
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
