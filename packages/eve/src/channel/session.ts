import type { RemoteChildBinding } from "#execution/child-binding.js";
import type { SessionReader } from "#shared/session.js";
import type { Delivery } from "#shared/delivery.js";
import { commandDelivery } from "#channel/delivery.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { PrewarmSessionResult } from "#protocol/prewarm-session.js";
import type { ContextAccessor } from "#context/key.js";
import { validateDeliveryIdempotencyKey } from "#channel/delivery-idempotency.js";
import {
  createChannelDeliveryMetadata,
  type ChannelDeliverySource,
} from "#channel/delivery-metadata.js";
import type { MessageContent } from "#shared/message-content.js";
import type {
  SessionStreamOptions,
  SessionControlOptions,
  Runtime,
  SessionAuthContext,
  SessionCallback,
  TurnPolicy,
  TurnCaller,
} from "#channel/types.js";
import { controlCommand, DEFAULT_TURN_POLICY } from "#channel/types.js";
import { serializeFilePartsInMessage } from "#channel/send-input.js";
import type { SessionAuth } from "#context/keys.js";
import type { ChannelContext } from "#shared/channel-context.js";
import {
  AuthKey,
  ContinuationHookTokensKey,
  ContinuationTokenKey,
  InitiatorAuthKey,
  SessionIdKey,
} from "#context/keys.js";
import { type Answer, type StrictAnswers, parseAnswers } from "#shared/input.js";
import type { JsonObject } from "#shared/json.js";
import { type SessionHistoryMessage, validateSessionHistory } from "#shared/session-history.js";
import { toChannelLocalContinuationToken } from "#shared/continuation-token.js";
import { attachClientContext, readClientContext } from "#internal/client-context.js";

/** Immutable-ID handle for one exact durable session. */
export interface Session extends SessionReader {
  send(message: MessageContent, options: SessionSendOptions): Promise<Delivery>;
  respond<const TAnswers extends readonly Answer[]>(
    answers: StrictAnswers<TAnswers>,
    options: SessionRespondOptions,
  ): Promise<Delivery>;
  cancel(options?: SessionControlOptions & { readonly turnId?: string | null }): Promise<Delivery>;
  /** Prepares an idle session on the deployment accepting this request, without a model turn. */
  prewarm(): Promise<PrewarmSessionResult>;
  clear(options?: SessionControlOptions): Promise<Delivery>;
  compact(options?: SessionControlOptions): Promise<Delivery>;
  reset(options?: SessionControlOptions & { readonly reason?: string }): Promise<Delivery>;
  /**
   * Opens the recorded stream. Following it throws `SessionStrandedError`
   * while its owner is stranded; `follow: false` reads recorded history up to
   * the current tail without inspecting or changing the session.
   */
  stream(options?: SessionStreamOptions): AsyncIterable<SessionStreamEvent>;
}

export interface InternalSession extends Session {
  getChildBinding?(childSessionId: string): Promise<RemoteChildBinding | undefined>;
  getLineStream(options?: SessionStreamOptions): Promise<ReadableStream<unknown>>;
  getStreamTailIndex(): Promise<number>;
  /** Whether a run that can still execute owns the session; `true` when the runtime can't tell. */
  hasRunnableOwner(): Promise<boolean>;
}

/** HTTP framing and conformance readers operate on framework-created handles. */
export function internalSession(session: Session): InternalSession {
  return session as InternalSession;
}

interface SessionDeliveryOptions {
  /** Stable delivery identity, deduplicated within this session's recent-key window. */
  readonly idempotencyKey?: string;
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
  readonly outputSchema?: JsonObject;
}

/** Options for sending a message through a fixed session handle. */
export type SessionSendOptions = SessionDeliveryOptions & {
  /** Prior conversation added as user and assistant turns before this message and its `context`. */
  readonly history?: readonly SessionHistoryMessage[];
  /** Initial workflow title for a prewarmed session. */
  readonly title?: string;
  readonly turnPolicy?: TurnPolicy;
};

/** Options for answering pending input requests through a fixed session handle. */
export type SessionRespondOptions = SessionDeliveryOptions;

interface InternalSessionDeliveryOptions extends SessionDeliveryOptions {
  readonly callback?: SessionCallback;
  /** The delivery's id, when the request names it (`deliveryIdForIdempotencyKey`). */
  readonly deliveryId?: string;
}

export function createSession(
  id: string,
  runtime: Runtime,
  metadata: Partial<ChannelDeliverySource> & { readonly turnPolicy?: TurnPolicy } = {},
): InternalSession {
  return {
    id,
    async send(message, options) {
      validateDeliveryIdempotencyKey(options.idempotencyKey);
      const delivery = createDelivery(
        metadata,
        (options as InternalSessionDeliveryOptions).deliveryId,
      );
      const caller = sessionCallbackToTurnCaller(
        (options as InternalSessionDeliveryOptions).callback,
      );
      const history = validateSessionHistory(options.history);
      const payload = attachClientContext<{
        context?: readonly string[];
        history?: readonly SessionHistoryMessage[];
        message: MessageContent | undefined;
        outputSchema?: JsonObject;
      }>({ message: serializeFilePartsInMessage(message) }, readClientContext(options));
      if (options.context !== undefined) payload.context = options.context;
      if (history !== undefined) payload.history = history;
      if (options.outputSchema !== undefined) payload.outputSchema = options.outputSchema;
      const commandWithoutCaller = {
        idempotencyKey: options.idempotencyKey,
        auth: options.auth,
        delivery,
        kind: "send" as const,
        payload,
        requestId: metadata.requestId,
        turnPolicy: options.turnPolicy ?? metadata.turnPolicy ?? DEFAULT_TURN_POLICY,
        title: options.title,
      };
      const result = await runtime.dispatchSession({
        command: caller === undefined ? commandWithoutCaller : { ...commandWithoutCaller, caller },
        sessionId: id,
      });
      return commandDelivery(runtime, result, delivery.deliveryId);
    },
    async respond(answers, options) {
      validateDeliveryIdempotencyKey(options.idempotencyKey);
      if (answers.length === 0) {
        throw new Error("respond() requires at least one answer.");
      }
      const validatedAnswers = parseAnswers(answers);
      const caller = sessionCallbackToTurnCaller(
        (options as InternalSessionDeliveryOptions).callback,
      );
      const delivery = createDelivery(
        metadata,
        (options as InternalSessionDeliveryOptions).deliveryId,
      );
      const payload = attachClientContext<{
        context?: readonly string[];
        answers: readonly Answer[];
        outputSchema?: JsonObject;
      }>({ answers: validatedAnswers }, readClientContext(options));
      if (options.context !== undefined) payload.context = options.context;
      if (options.outputSchema !== undefined) payload.outputSchema = options.outputSchema;
      const commandWithoutCaller = {
        idempotencyKey: options.idempotencyKey,
        auth: options.auth,
        delivery,
        kind: "send" as const,
        payload,
        requestId: metadata.requestId,
      };
      const result = await runtime.dispatchSession({
        command: caller === undefined ? commandWithoutCaller : { ...commandWithoutCaller, caller },
        sessionId: id,
      });
      return commandDelivery(runtime, result, delivery.deliveryId);
    },
    async cancel(options) {
      const command = controlCommand({ kind: "cancel" as const, turnId: options?.turnId }, options);
      const result = await runtime.dispatchSession({ command, sessionId: id });
      return commandDelivery(runtime, result, command.deliveryId);
    },
    async prewarm() {
      return await runtime.dispatchSession({
        command: { kind: "prewarm", targetDeploymentId: metadata.acceptedDeploymentId },
        sessionId: id,
      });
    },
    async compact(options) {
      const command = controlCommand({ kind: "compact" as const }, options);
      const result = await runtime.dispatchSession({ command, sessionId: id });
      return commandDelivery(runtime, result, command.deliveryId);
    },
    async clear(options) {
      const command = controlCommand({ kind: "clear" as const }, options);
      const result = await runtime.dispatchSession({ command, sessionId: id });
      return commandDelivery(runtime, result, command.deliveryId);
    },
    async reset(options) {
      const command = controlCommand({ kind: "reset" as const, reason: options?.reason }, options);
      const result = await runtime.dispatchSession({ command, sessionId: id });
      return commandDelivery(runtime, result, command.deliveryId, { follow: false });
    },
    async *stream(options?: SessionStreamOptions) {
      yield* await runtime.getEventStream(id, options);
    },
    async getLineStream(options?: SessionStreamOptions) {
      return runtime.getLineStream(id, options);
    },
    async getStreamTailIndex() {
      return runtime.getStreamTailIndex(id);
    },
    async hasRunnableOwner() {
      return (await runtime.hasRunnableOwner?.(id)) ?? true;
    },
    async getChildBinding(childSessionId: string) {
      return await runtime.readChildBinding?.(id, childSessionId);
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

function createDelivery(metadata: Partial<ChannelDeliverySource>, deliveryId?: string) {
  const delivery = createChannelDeliveryMetadata({
    channelKind: "http",
    channelName: "http",
    ...metadata,
  });
  return deliveryId === undefined ? delivery : { ...delivery, deliveryId };
}

/** Live metadata and routing authority stay separate, including when auth changes mid-step. */
export function buildChannelContext(accessor: ContextAccessor): ChannelContext {
  return {
    session: {
      get id() {
        return accessor.get(SessionIdKey) ?? "";
      },
      get auth(): SessionAuth {
        return {
          current: accessor.get(AuthKey) ?? null,
          initiator: accessor.get(InitiatorAuthKey) ?? null,
        };
      },
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
