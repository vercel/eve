import type { UserContent } from "ai";

import type { ChannelAdapter } from "#channel/adapter.js";
import { validateDeliveryIdempotencyKey } from "#channel/delivery-idempotency.js";
import {
  createChannelDeliveryMetadata,
  type ChannelDeliverySource,
} from "#channel/delivery-metadata.js";
import type { SendPayload } from "#channel/routes.js";
import { normalizeSendInput, serializeFilePartsInMessage } from "#channel/send-input.js";
import { createSession, sessionCallbackToTurnCaller, type Session } from "#channel/session.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import { describeStrandedSession, SessionStrandedError } from "#channel/session-stranded-error.js";
import type {
  CancelTurnResult,
  ClearSessionResult,
  CompactSessionResult,
  ResetSessionResult,
  RunInput,
  Runtime,
  SessionAuthContext,
  SessionCallback,
  SessionCommand,
  TurnPolicy,
} from "#channel/types.js";
import { DEFAULT_TURN_POLICY } from "#channel/types.js";
import { isReservedSessionCommandToken } from "#execution/session-inbox/address.js";
import { validateSessionHistory } from "#shared/session-history.js";

interface BaseChannelAddressCreateOptions {
  readonly auth: SessionAuthContext | null;
  readonly history?: SendPayload["history"];
  readonly initiatorAuth?: SessionAuthContext | null;
  readonly title?: string;
}

type ChannelAddressCreateOptions<TState = undefined> = [TState] extends [undefined]
  ? BaseChannelAddressCreateOptions
  : BaseChannelAddressCreateOptions & { readonly state?: Partial<TState> };

interface BaseChannelAddressDeliveryOptions {
  readonly idempotencyKey?: string;
  readonly auth: SessionAuthContext | null;
  readonly callback?: SessionCallback;
  readonly initiatorAuth?: SessionAuthContext | null;
  readonly title?: string;
  readonly turnPolicy?: TurnPolicy;
}

/**
 * Result of `create()`. `created` is `false` when another session already owned the address, or
 * won it concurrently; that session is returned unchanged and any `history` was not added.
 */
export interface ChannelCreateResult {
  readonly created: boolean;
  readonly session: Session;
}

/** Delivery options for a channel address whose continuation token is already bound. */
export type ChannelAddressDeliveryOptions<TState = undefined> = [TState] extends [undefined]
  ? BaseChannelAddressDeliveryOptions
  : BaseChannelAddressDeliveryOptions & { readonly state?: Partial<TState> };

/**
 * Dynamic handle for whichever durable session currently owns one channel-local address.
 * Only {@link create} and {@link send} may create a session: when the address is unowned, and
 * `send` also in place of a stranded session that another eve version built. Sends to a session whose
 * owner is only unavailable throw `SessionStrandedError` and deliver nothing.
 * Responses to an address no session holds throw `SessionNotActiveError`.
 */
interface ChannelAddress<TState = undefined> {
  readonly continuationToken: string;
  deliver(input: SendPayload, options: ChannelAddressDeliveryOptions<TState>): Promise<Session>;
  create(options: ChannelAddressCreateOptions<TState>): Promise<ChannelCreateResult>;
  send(
    message: string | UserContent,
    options: ChannelAddressDeliveryOptions<TState>,
  ): Promise<Session>;
  respond(
    inputResponses: SendPayload["inputResponses"],
    options: ChannelAddressDeliveryOptions<TState>,
  ): Promise<Session>;
  cancel(options?: { readonly turnId?: string }): Promise<CancelTurnResult>;
  compact(): Promise<CompactSessionResult>;
  clear(): Promise<ClearSessionResult>;
  reset(options?: { readonly reason?: string }): Promise<ResetSessionResult>;
  resolveSession(): Promise<Session | undefined>;
}

/** Factory for binding a route-local continuation token to a {@link ChannelAddress}. */
type ChannelAddressFn<TState = undefined> = (continuationToken: string) => ChannelAddress<TState>;

/** Creates one channel address backed by the runtime's continuation dispatch primitive. */
export function createChannelAddress<TState = undefined>(input: {
  readonly adapter: ChannelAdapter<any>;
  readonly channelName: string;
  readonly continuationToken: string;
  readonly metadata?: ChannelDeliverySource;
  readonly runtime: Runtime;
  readonly turnPolicy?: TurnPolicy;
}): ChannelAddress<TState> {
  const metadata: Partial<ChannelDeliverySource> = input.metadata ?? {};
  const namespacedToken = `${input.channelName}:${input.continuationToken}`;
  if (isReservedSessionCommandToken(namespacedToken)) {
    throw new Error(`Channel address "${namespacedToken}" uses eve's reserved session namespace.`);
  }

  return {
    continuationToken: input.continuationToken,
    async deliver(sendInput, options) {
      validateDeliveryIdempotencyKey(options.idempotencyKey);
      const delivery =
        metadata.channelKind !== undefined && metadata.channelName !== undefined
          ? createChannelDeliveryMetadata(metadata as ChannelDeliverySource)
          : undefined;
      const payload = withValidatedHistory(normalizeSendInput(sendInput));
      const caller = sessionCallbackToTurnCaller(options.callback);
      const commandWithoutCaller = {
        idempotencyKey: options.idempotencyKey,
        auth: options.auth,
        delivery,
        kind: "send" as const,
        payload: {
          ...payload,
          message: serializeFilePartsInMessage(payload.message),
        },
        requestId: metadata.requestId,
        turnPolicy:
          payload.message === undefined
            ? undefined
            : (options.turnPolicy ?? input.turnPolicy ?? DEFAULT_TURN_POLICY),
      };
      const command: Extract<SessionCommand, { readonly kind: "send" }> =
        caller === undefined ? commandWithoutCaller : { ...commandWithoutCaller, caller };
      const state = (options as { readonly state?: TState }).state;
      const adapter =
        state === undefined
          ? input.adapter
          : {
              ...input.adapter,
              state: { ...input.adapter.state, ...(state as Record<string, unknown>) },
            };
      const runInput: RunInput = {
        idempotencyKey: options.idempotencyKey,
        adapter,
        auth: options.auth,
        capabilities: { requestInput: true },
        callback: options.callback,
        channelName: input.channelName,
        continuationConflictCommand: command,
        continuationToken: namespacedToken,
        delivery,
        initiatorAuth: options.initiatorAuth,
        input: {
          context: payload.context,
          history: payload.history,
          message: serializeFilePartsInMessage(payload.message) ?? "",
          outputSchema: payload.outputSchema,
          state: payload.state,
        },
        requestId: metadata.requestId,
        title: options.title,
      };
      const toSession = (sessionId: string) =>
        createSession(sessionId, input.runtime, { ...metadata, turnPolicy: input.turnPolicy });

      const result = await input.runtime.dispatchContinuation({
        command,
        continuationToken: namespacedToken,
        successor: runInput,
      });
      if (result.status === "accepted") return toSession(result.sessionId);
      if (payload.inputResponses && payload.inputResponses.length > 0) {
        throw new SessionNotActiveError();
      }
      return toSession((await input.runtime.createSession(runInput)).sessionId);
    },
    async create(options) {
      const history = validateSessionHistory(options.history);
      const toSession = (sessionId: string) =>
        createSession(sessionId, input.runtime, { ...metadata, turnPolicy: input.turnPolicy });
      let owner: { readonly sessionId: string } | undefined;
      try {
        owner = await input.runtime.resolveContinuation(namespacedToken, { runnable: true });
      } catch (error) {
        // Replacing a stranded session would end a conversation the caller may mean to import.
        if (!SessionStrandedError.is(error)) throw error;
        throw new SessionStrandedError(
          error.owner,
          describeStrandedSession(
            error.owner,
            "Call reset() on the address, then create() again to start a session from your history.",
          ),
        );
      }
      if (owner !== undefined) return { created: false, session: toSession(owner.sessionId) };
      const state = (options as { readonly state?: TState }).state;
      const started = await input.runtime.createSession({
        adapter:
          state === undefined
            ? input.adapter
            : {
                ...input.adapter,
                state: { ...input.adapter.state, ...(state as Record<string, unknown>) },
              },
        auth: options.auth,
        capabilities: { requestInput: true },
        channelName: input.channelName,
        continuationToken: namespacedToken,
        initiatorAuth: options.initiatorAuth,
        input: history === undefined ? {} : { history },
        requestId: metadata.requestId,
        title: options.title,
      });
      // The new run claims the address asynchronously, and a concurrent `create()` or `send()`
      // may claim it first. Waiting for the owner lets an immediate `send()` find it, and tells
      // the caller whether its history landed: a losing run exits without forwarding anything.
      const claimed = await waitForContinuationOwner(
        input.runtime,
        namespacedToken,
        started.sessionId,
      );
      return {
        created: claimed.sessionId === started.sessionId,
        session: toSession(claimed.sessionId),
      };
    },
    async send(message, options) {
      return await this.deliver({ message }, options);
    },
    async respond(inputResponses, options) {
      if (inputResponses === undefined || inputResponses.length === 0) {
        throw new Error("respond() requires at least one input response.");
      }
      return await this.deliver({ inputResponses }, options);
    },
    async cancel(options) {
      return await input.runtime.dispatchContinuation({
        command: { kind: "cancel", turnId: options?.turnId },
        continuationToken: namespacedToken,
      });
    },
    async compact() {
      return await input.runtime.dispatchContinuation({
        command: { kind: "compact" },
        continuationToken: namespacedToken,
      });
    },
    async clear() {
      return await input.runtime.dispatchContinuation({
        command: { kind: "clear" },
        continuationToken: namespacedToken,
      });
    },
    async reset(options) {
      return await input.runtime.dispatchContinuation({
        command: { kind: "reset", reason: options?.reason },
        continuationToken: namespacedToken,
      });
    },
    async resolveSession() {
      const owner = await input.runtime.resolveContinuation(namespacedToken);
      return owner === undefined
        ? undefined
        : createSession(owner.sessionId, input.runtime, {
            ...metadata,
            turnPolicy: input.turnPolicy,
          });
    },
  };
}

/** Builds a request-scoped factory for channel addresses on one authored channel. */
export function createChannelAddressFn<TState = undefined>(input: {
  readonly adapter: ChannelAdapter<any>;
  readonly channelName: string;
  readonly metadata?: ChannelDeliverySource;
  readonly runtime: Runtime;
  readonly turnPolicy?: TurnPolicy;
}): ChannelAddressFn<TState> {
  return (continuationToken) => createChannelAddress({ ...input, continuationToken });
}

function withValidatedHistory(payload: SendPayload): SendPayload {
  const { history, ...rest } = payload;
  const validated = validateSessionHistory(history);
  return validated === undefined ? rest : { ...rest, history: validated };
}

const CREATE_CLAIM_TIMEOUT_MS = 15_000;

async function waitForContinuationOwner(
  runtime: Runtime,
  continuationToken: string,
  startedSessionId: string,
): Promise<{ readonly sessionId: string }> {
  const deadline = Date.now() + CREATE_CLAIM_TIMEOUT_MS;
  for (let delayMs = 25; ; delayMs = Math.min(delayMs * 2, 500)) {
    const owner = await runtime.resolveContinuation(continuationToken);
    if (owner !== undefined) return owner;
    if (Date.now() + delayMs > deadline) {
      // Unclaimed, the address may still go to this run or to a concurrent one, so neither
      // `created` value would be true yet.
      throw new Error(
        `create() started session "${startedSessionId}" for "${continuationToken}", but no session claimed the address within ${CREATE_CLAIM_TIMEOUT_MS / 1000}s. Call resolveSession() on the address to find its owner once one does.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
