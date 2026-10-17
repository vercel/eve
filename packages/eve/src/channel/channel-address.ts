import type { MessageContent } from "#shared/message-content.js";
import type { Delivery } from "#shared/delivery.js";
import { commandDelivery } from "#channel/delivery.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";

import type { ChannelAdapter } from "#channel/adapter.js";
import {
  createChannelDeliveryMetadata,
  type ChannelDeliverySource,
} from "#channel/delivery-metadata.js";
import type { SendPayload } from "#channel/routes.js";
import { normalizeSendInput, serializeFilePartsInMessage } from "#channel/send-input.js";
import { createSession, sessionCallbackToTurnCaller, type Session } from "#channel/session.js";
import type {
  RunInput,
  Runtime,
  SessionAuthContext,
  SessionCallback,
  SessionCommand,
  TurnPolicy,
} from "#channel/types.js";
import { controlCommand, DEFAULT_TURN_POLICY } from "#channel/types.js";
import type { SessionControlOptions } from "#channel/types.js";
import { isReservedSessionCommandToken } from "#execution/session-inbox/address.js";

interface BaseChannelAddressDeliveryOptions {
  readonly auth: SessionAuthContext | null;
  readonly callback?: SessionCallback;
  readonly initiatorAuth?: SessionAuthContext | null;
  readonly title?: string;
  readonly turnPolicy?: TurnPolicy;
}

/** Delivery options for a channel address whose continuation token is already bound. */
export type ChannelAddressDeliveryOptions<TState = undefined> = [TState] extends [undefined]
  ? BaseChannelAddressDeliveryOptions
  : BaseChannelAddressDeliveryOptions & { readonly state?: Partial<TState> };

/**
 * Dynamic handle for whichever durable session currently owns one channel-local address.
 * Only {@link send} may create a session: when the address is unowned, or in
 * place of a stranded session that another eve version built. Sends to a session whose
 * owner is only unavailable throw `SessionStrandedError` and deliver nothing.
 */
interface ChannelAddress<TState = undefined> {
  readonly continuationToken: string;
  deliver(input: SendPayload, options: ChannelAddressDeliveryOptions<TState>): Promise<Delivery>;
  send(message: MessageContent, options: ChannelAddressDeliveryOptions<TState>): Promise<Delivery>;
  respond(
    answers: SendPayload["answers"],
    options: ChannelAddressDeliveryOptions<TState>,
  ): Promise<Delivery>;
  cancel(options?: { readonly turnId?: string | null } & SessionControlOptions): Promise<Delivery>;
  compact(options?: SessionControlOptions): Promise<Delivery>;
  clear(options?: SessionControlOptions): Promise<Delivery>;
  reset(options?: { readonly reason?: string } & SessionControlOptions): Promise<Delivery>;
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
      const delivery = createChannelDeliveryMetadata({
        channelKind: `channel:${input.channelName}`,
        channelName: input.channelName,
        ...metadata,
      });
      const payload = normalizeSendInput(sendInput);
      const caller = sessionCallbackToTurnCaller(options.callback);
      const commandWithoutCaller = {
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
          message: serializeFilePartsInMessage(payload.message) ?? "",
          outputSchema: payload.outputSchema,
          state: payload.state,
        },
        requestId: metadata.requestId,
        title: options.title,
      };
      const result = await input.runtime.dispatchContinuation({
        command,
        continuationToken: namespacedToken,
        successor: runInput,
      });
      if (result.status === "accepted")
        return commandDelivery(input.runtime, result, delivery.deliveryId);
      if (result.retryable === true) throw new SessionNotActiveError({ retryable: true });
      if (payload.answers && payload.answers.length > 0) {
        throw new SessionNotActiveError();
      }
      const started = await input.runtime.createSession(runInput);
      return commandDelivery(
        input.runtime,
        { status: "accepted", sessionId: started.sessionId },
        delivery.deliveryId,
      );
    },
    async send(message, options) {
      return await this.deliver({ message }, options);
    },
    async respond(answers, options) {
      if (answers === undefined || answers.length === 0) {
        throw new Error("respond() requires at least one answer.");
      }
      return await this.deliver({ answers }, options);
    },
    async cancel(options) {
      const command = controlCommand({ kind: "cancel" as const, turnId: options?.turnId }, options);
      const result = await input.runtime.dispatchContinuation({
        command,
        continuationToken: namespacedToken,
      });
      return commandDelivery(input.runtime, result, command.deliveryId);
    },
    async compact(options) {
      const command = controlCommand({ kind: "compact" as const }, options);
      const result = await input.runtime.dispatchContinuation({
        command,
        continuationToken: namespacedToken,
      });
      return commandDelivery(input.runtime, result, command.deliveryId);
    },
    async clear(options) {
      const command = controlCommand({ kind: "clear" as const }, options);
      const result = await input.runtime.dispatchContinuation({
        command,
        continuationToken: namespacedToken,
      });
      return commandDelivery(input.runtime, result, command.deliveryId);
    },
    async reset(options) {
      const command = controlCommand({ kind: "reset" as const, reason: options?.reason }, options);
      const result = await input.runtime.dispatchContinuation({
        command,
        continuationToken: namespacedToken,
      });
      return commandDelivery(input.runtime, result, command.deliveryId, { follow: false });
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
