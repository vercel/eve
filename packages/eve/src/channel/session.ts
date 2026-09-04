import type { ContextAccessor } from "#context/key.js";
import {
  createChannelDeliveryMetadata,
  type ChannelDeliverySource,
} from "#channel/delivery-metadata.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type { UserContent } from "ai";
import type {
  ActivityObserverConfig,
  CancelTurnResult,
  ClearSessionResult,
  CompactSessionResult,
  ResetSessionResult,
  Runtime,
  SessionAuthContext,
  SessionCallback,
  SessionSendCommandResult,
  SessionTraceCoordinates,
  TurnPolicy,
  TurnCaller,
} from "#channel/types.js";
import { DEFAULT_TURN_POLICY } from "#channel/types.js";
import { serializeUrlFilePartsInMessage } from "#channel/send-input.js";
import type { SessionAuth } from "#context/keys.js";
import { AuthKey, ContinuationTokenKey, InitiatorAuthKey, SessionIdKey } from "#context/keys.js";
import {
  type InputResponse,
  parseInputResponses,
  type StrictInputResponses,
} from "#shared/input.js";
import type { JsonObject } from "#shared/json.js";
import { toChannelLocalContinuationToken } from "#shared/continuation-token.js";
import { attachClientContext, readClientContext } from "#internal/client-context.js";

/** Immutable-ID handle for one exact durable session. */
export interface Session {
  readonly id: string;
  /** @internal Trace coordinates acknowledged when this session was created. */
  readonly trace?: SessionTraceCoordinates;
  /** Sends a message to this exact session ID without creating or following a replacement. */
  send(
    message: string | UserContent,
    options: SessionSendOptions,
  ): Promise<SessionSendCommandResult>;
  /** Answers pending input requests on this exact session ID. */
  respond<const TResponses extends readonly InputResponse[]>(
    inputResponses: StrictInputResponses<TResponses>,
    options: SessionRespondOptions,
  ): Promise<SessionSendCommandResult>;
  /** Requests cancellation of this exact session's active turn and optionally its owned tasks. */
  cancel(options?: {
    taskId?: string;
    tasks?: boolean;
    turnId?: string;
  }): Promise<CancelTurnResult>;
  /** Queues compaction on this exact session ID. */
  compact(): Promise<CompactSessionResult>;
  /** Queues a context clear on this exact session ID. */
  clear(): Promise<ClearSessionResult>;
  /** Terminally retires this exact session ID. */
  reset(options?: { reason?: string }): Promise<ResetSessionResult>;
  getEventStream(options?: { startIndex?: number }): Promise<ReadableStream<MessageStreamEvent>>;
  getStreamTailIndex(): Promise<number>;
}

interface SessionDeliveryOptions {
  readonly activityObserver?: ActivityObserverConfig;
  readonly auth: SessionAuthContext | null;
  /** Public callback destination for a delegated continuation turn. */
  readonly callback?: SessionCallback;
  readonly context?: readonly string[];
  readonly outputSchema?: JsonObject;
}

/** Options for sending a message through a fixed session handle. */
export type SessionSendOptions = SessionDeliveryOptions & { readonly turnPolicy?: TurnPolicy };

/** Options for answering pending input requests through a fixed session handle. */
export type SessionRespondOptions = SessionDeliveryOptions;

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
  metadata: Partial<ChannelDeliverySource> & {
    readonly trace?: SessionTraceCoordinates;
    readonly turnPolicy?: TurnPolicy;
  } = {},
): Session {
  return {
    id,
    trace: metadata.trace,
    async send(message, options) {
      const delivery = createDelivery(metadata);
      const caller = sessionCallbackToTurnCaller(options.callback, options.activityObserver);
      const payload = attachClientContext<{
        context?: readonly string[];
        message: string | UserContent | undefined;
        outputSchema?: JsonObject;
      }>({ message: serializeUrlFilePartsInMessage(message) }, readClientContext(options));
      if (options.context !== undefined) payload.context = options.context;
      if (options.outputSchema !== undefined) payload.outputSchema = options.outputSchema;
      const commandWithoutCaller = {
        auth: options.auth,
        delivery,
        kind: "send" as const,
        payload,
        requestId: metadata.requestId,
        turnPolicy: options.turnPolicy ?? metadata.turnPolicy ?? DEFAULT_TURN_POLICY,
      };
      return await runtime.dispatchSession({
        command: caller === undefined ? commandWithoutCaller : { ...commandWithoutCaller, caller },
        sessionId: id,
      });
    },
    async respond(inputResponses, options) {
      if (inputResponses.length === 0) {
        throw new Error("respond() requires at least one input response.");
      }
      const validatedInputResponses = parseInputResponses(inputResponses);
      const caller = sessionCallbackToTurnCaller(options.callback, options.activityObserver);
      const delivery = createDelivery(metadata);
      const payload = attachClientContext<{
        context?: readonly string[];
        inputResponses: readonly InputResponse[];
        outputSchema?: JsonObject;
      }>({ inputResponses: validatedInputResponses }, readClientContext(options));
      if (options.context !== undefined) payload.context = options.context;
      if (options.outputSchema !== undefined) payload.outputSchema = options.outputSchema;
      const commandWithoutCaller = {
        auth: options.auth,
        delivery,
        kind: "send" as const,
        payload,
        requestId: metadata.requestId,
      };
      return await runtime.dispatchSession({
        command: caller === undefined ? commandWithoutCaller : { ...commandWithoutCaller, caller },
        sessionId: id,
      });
    },
    async cancel(options?: { taskId?: string; tasks?: boolean; turnId?: string }) {
      const command: { kind: "cancel"; taskId?: string; tasks?: boolean; turnId?: string } = {
        kind: "cancel",
      };
      if (options?.taskId !== undefined) command.taskId = options.taskId;
      if (options?.tasks !== undefined) command.tasks = options.tasks;
      if (options?.turnId !== undefined) command.turnId = options.turnId;
      return await runtime.dispatchSession({ command, sessionId: id });
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
  metadata: Partial<ChannelDeliverySource> & { readonly turnPolicy?: TurnPolicy } = {},
): (sessionId: string) => Session {
  return (sessionId) => createSession(sessionId, runtime, metadata);
}

function createDelivery(
  metadata: Partial<ChannelDeliverySource>,
): ReturnType<typeof createChannelDeliveryMetadata> | undefined {
  return metadata.channelKind !== undefined && metadata.channelName !== undefined
    ? createChannelDeliveryMetadata(metadata as ChannelDeliverySource)
    : undefined;
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
        token: toChannelLocalContinuationToken(currentToken),
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

/** @internal Converts validated public callback metadata into runtime turn routing. */
export function sessionCallbackToTurnCaller(
  callback: SessionCallback | undefined,
  activityObserver?: ActivityObserverConfig,
): TurnCaller | undefined {
  return callback === undefined
    ? undefined
    : {
        activityObserver,
        callId: callback.callId,
        replyTo: { kind: "callback", token: callback.token, url: callback.url },
        subagentName: callback.subagentName,
        taskId: callback.taskId,
      };
}
