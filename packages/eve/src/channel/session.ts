import type { RemoteChildBinding } from "#execution/child-binding.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { legacyEventStream, legacyTailIndex } from "#execution/legacy-event-stream.js";
import type { ContextAccessor } from "#context/key.js";
import {
  createChannelDeliveryMetadata,
  type ChannelDeliverySource,
} from "#channel/delivery-metadata.js";
import type { UserContent } from "ai";
import type {
  CancelTurnResult,
  ClearSessionResult,
  CompactSessionResult,
  ResetSessionResult,
  Runtime,
  SessionAuthContext,
  SessionCallback,
  SessionSendCommandResult,
  TurnPolicy,
  TurnCaller,
} from "#channel/types.js";
import { controlCommand, DEFAULT_TURN_POLICY } from "#channel/types.js";
import type { SessionControlOptions } from "#channel/types.js";
import { serializeUrlFilePartsInMessage } from "#channel/send-input.js";
import type { SessionAuth } from "#context/keys.js";
import {
  AuthKey,
  ContinuationHookTokensKey,
  ContinuationTokenKey,
  InitiatorAuthKey,
  SessionIdKey,
} from "#context/keys.js";
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

/**
 * What the framework reads of a session beyond its authored handle: its stored lines and the
 * facts they hold, positions in lines, controls that name their sender, and where a remote child
 * runs. The handle's own stream serves the v26 events authored code reads.
 */
export interface SessionInternals {
  /** The session's facts and progress records from line `startIndex`, as stored. */
  facts(options?: { startIndex?: number }): Promise<ReadableStream<SessionStreamEvent>>;
  /** The session's stored lines from `startIndex`: one parsed record per line. */
  lines(options?: { startIndex?: number }): Promise<ReadableStream<unknown>>;
  /** The position of the session's last stored line, or `-1` before the first. */
  tailLine(): Promise<number>;
  /** A control as a delivery that names its sender. */
  control(
    command:
      | { readonly kind: "cancel"; readonly turnId?: string }
      | { readonly kind: "compact" }
      | { readonly kind: "clear" }
      | { readonly kind: "reset"; readonly reason?: string },
    options?: SessionControlOptions,
  ): Promise<unknown>;
  /** Where a remote child of this session runs; read only by the parent's stream proxy. */
  childBinding(childSessionId: string): Promise<RemoteChildBinding | undefined>;
}

const sessionInternalsByHandle = new WeakMap<Session, SessionInternals>();

/** The framework's view of a session handle this module created; `undefined` for others. */
export function sessionInternals(session: Session): SessionInternals | undefined {
  return sessionInternalsByHandle.get(session);
}

interface SessionDeliveryOptions {
  readonly auth: SessionAuthContext | null;
  /** Public callback destination for a delegated continuation turn. */
  readonly callback?: SessionCallback;
  readonly context?: readonly string[];
  readonly outputSchema?: JsonObject;
}

/** Options for sending a message through a fixed session handle. */
export type SessionSendOptions = SessionDeliveryOptions & {
  /** Initial workflow title for a prewarmed session. */
  readonly title?: string;
  readonly turnPolicy?: TurnPolicy;
};

/** Options for answering pending input requests through a fixed session handle. */
export type SessionRespondOptions = SessionDeliveryOptions;

/**
 * Live handle to the current session, exposed on `ctx.session` to
 * `deliver` and event handlers. The framework hydrates the read-only
 * fields from the active context at step start. A write through
 * `continuation.alias()` selects a new current address and records it so the
 * runtime can add its hook to the session inbox at the next step boundary.
 * Previously claimed addresses remain active.
 */
export interface SessionHandle {
  readonly id: string;
  readonly auth: SessionAuth;
  readonly continuation?: {
    readonly token: string;
    alias(rawToken: string): void;
  };
}

export function createSession(
  id: string,
  runtime: Runtime,
  metadata: Partial<ChannelDeliverySource> & { readonly turnPolicy?: TurnPolicy } = {},
): Session {
  const session = createSessionHandle(id, runtime, metadata);
  sessionInternalsByHandle.set(session, {
    async childBinding(childSessionId) {
      return await runtime.readChildBinding?.(id, childSessionId);
    },
    async control(command, options) {
      return await runtime.dispatchSession({
        command: controlCommand(command, options),
        sessionId: id,
      });
    },
    async facts(options) {
      return await runtime.getEventStream(id, options);
    },
    async lines(options) {
      return await runtime.getLineStream(id, options);
    },
    async tailLine() {
      return await runtime.getStreamTailIndex(id);
    },
  });
  return session;
}

function createSessionHandle(
  id: string,
  runtime: Runtime,
  metadata: Partial<ChannelDeliverySource> & { readonly turnPolicy?: TurnPolicy },
): Session {
  return {
    id,
    async send(message, options) {
      const delivery = createDelivery(metadata);
      const caller = sessionCallbackToTurnCaller(options.callback);
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
        title: options.title,
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
      const caller = sessionCallbackToTurnCaller(options.callback);
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
    async cancel(options?: { turnId?: string }) {
      const command: { kind: "cancel"; turnId?: string } = { kind: "cancel" };
      if (options?.turnId !== undefined) command.turnId = options.turnId;
      return await runtime.dispatchSession({ command: controlCommand(command), sessionId: id });
    },
    async compact() {
      return await runtime.dispatchSession({
        command: controlCommand({ kind: "compact" }),
        sessionId: id,
      });
    },
    async clear() {
      return await runtime.dispatchSession({
        command: controlCommand({ kind: "clear" }),
        sessionId: id,
      });
    },
    async reset(options) {
      return await runtime.dispatchSession({
        command: controlCommand({ kind: "reset", reason: options?.reason }),
        sessionId: id,
      });
    },
    // The handle reads the v26 events the stored facts stand for, counted in events, as authored
    // code always has; see `execution/legacy-events.ts`.
    async getEventStream(options?: { startIndex?: number }) {
      return legacyEventStream(runtime, id, options?.startIndex);
    },
    async getStreamTailIndex() {
      return await legacyTailIndex(runtime, id);
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
        alias(rawToken: string): void {
          if (rawToken.length === 0) throw new Error("A session alias requires a nonempty token.");
          const token = namespaceContinuationToken(currentToken, rawToken);
          if (currentToken === token) return;
          accessor.set(ContinuationHookTokensKey, (claimed) => {
            const tokens = claimed ?? [currentToken];
            return tokens.includes(token) ? tokens : [...tokens, token];
          });
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
): TurnCaller | undefined {
  return callback === undefined
    ? undefined
    : {
        callId: callback.callId,
        replyTo: { kind: "callback", token: callback.token, url: callback.url },
        subagentName: callback.subagentName,
      };
}
