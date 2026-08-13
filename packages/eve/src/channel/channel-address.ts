import type { UserContent } from "ai";

import type { ChannelAdapter } from "#channel/adapter.js";
import {
  createChannelDeliveryMetadata,
  type ChannelDeliverySource,
} from "#channel/delivery-metadata.js";
import type { SendPayload } from "#channel/routes.js";
import { normalizeSendInput, serializeUrlFilePartsInMessage } from "#channel/send-input.js";
import { createSession, sessionCallbackToTurnCaller, type Session } from "#channel/session.js";
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
import { isRuntimeSessionOwnershipConflictError } from "#execution/runtime-errors.js";
import { isReservedSessionCommandToken } from "#execution/session-command-token.js";
import type { RunMode } from "#shared/run-mode.js";

interface BaseChannelAddressDeliveryOptions {
  readonly auth: SessionAuthContext | null;
  readonly callback?: SessionCallback;
  readonly initiatorAuth?: SessionAuthContext | null;
  readonly mode?: RunMode;
  readonly title?: string;
  readonly turnPolicy?: TurnPolicy;
}

/** Delivery options for a channel address whose continuation token is already bound. */
export type ChannelAddressDeliveryOptions<TState = undefined> = [TState] extends [undefined]
  ? BaseChannelAddressDeliveryOptions
  : BaseChannelAddressDeliveryOptions & { readonly state?: TState };

/**
 * Dynamic handle for whichever durable session currently owns one channel-local address.
 * Only {@link send} may create a session when the address is unowned.
 */
export interface ChannelAddress<TState = undefined> {
  readonly continuationToken: string;
  deliver(input: SendPayload, options: ChannelAddressDeliveryOptions<TState>): Promise<Session>;
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

export async function dispatchOrCreateChannelRoute<TState>(input: {
  readonly address: ChannelAddress<TState>;
  readonly command: Extract<SessionCommand, { readonly kind: "route-remote" }>;
  readonly options: ChannelAddressDeliveryOptions<TState>;
}): Promise<Session> {
  return await (input.address as InternalChannelAddress<TState>).dispatchRoute(
    input.command,
    input.options,
  );
}

interface InternalChannelAddress<TState = undefined> extends ChannelAddress<TState> {
  dispatchRoute(
    command: Extract<SessionCommand, { readonly kind: "route-remote" }>,
    options: ChannelAddressDeliveryOptions<TState>,
  ): Promise<Session>;
}

/** Factory for binding a route-local continuation token to a {@link ChannelAddress}. */
export type ChannelAddressFn<TState = undefined> = (
  continuationToken: string,
) => InternalChannelAddress<TState>;

/** Creates one channel address backed by the runtime's continuation dispatch primitive. */
export function createChannelAddress<TState = undefined>(input: {
  readonly adapter: ChannelAdapter<any>;
  readonly channelName: string;
  readonly continuationToken: string;
  readonly metadata?: ChannelDeliverySource;
  readonly runtime: Runtime;
  readonly turnPolicy?: TurnPolicy;
}): InternalChannelAddress<TState> {
  const metadata: Partial<ChannelDeliverySource> = input.metadata ?? {};
  const namespacedToken = `${input.channelName}:${input.continuationToken}`;
  if (isReservedSessionCommandToken(namespacedToken)) {
    throw new Error(`Channel address "${namespacedToken}" uses eve's reserved session namespace.`);
  }

  const fixedSession = (sessionId: string): Session =>
    createSession(sessionId, input.runtime, {
      ...metadata,
      turnPolicy: input.turnPolicy,
    });
  const mergeAdapterState = (state: TState | undefined): ChannelAdapter<any> =>
    state === undefined
      ? input.adapter
      : {
          ...input.adapter,
          state: { ...input.adapter.state, ...(state as Record<string, unknown>) },
        };
  const dispatchOrCreateSession = async (args: {
    readonly command: Extract<SessionCommand, { readonly kind: "send" | "route-remote" }>;
    readonly createRunInput: (adapter: ChannelAdapter<any>) => RunInput;
    readonly state?: TState;
  }): Promise<Session> => {
    const dispatch = async (): Promise<Session | undefined> => {
      const result = await input.runtime.dispatchContinuation({
        command: args.command,
        continuationToken: namespacedToken,
      });
      return result.status === "accepted" ? fixedSession(result.sessionId) : undefined;
    };
    const existing = await dispatch();
    if (existing !== undefined) return existing;
    try {
      const handle = await input.runtime.createSession(
        args.createRunInput(mergeAdapterState(args.state)),
      );
      return fixedSession(handle.sessionId);
    } catch (error) {
      if (!isRuntimeSessionOwnershipConflictError(error)) throw error;
      const winner = await dispatch();
      if (winner !== undefined) return winner;
      throw error;
    }
  };

  return {
    continuationToken: input.continuationToken,
    async deliver(sendInput, options) {
      const delivery =
        metadata.channelKind !== undefined && metadata.channelName !== undefined
          ? createChannelDeliveryMetadata(metadata as ChannelDeliverySource)
          : undefined;
      const payload = normalizeSendInput(sendInput);
      const caller = sessionCallbackToTurnCaller(options.callback);
      const commandWithoutCaller = {
        auth: options.auth,
        delivery,
        kind: "send" as const,
        payload: {
          ...payload,
          message: serializeUrlFilePartsInMessage(payload.message),
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
      const createRunInput = (adapter: ChannelAdapter<any>): RunInput => {
        if (payload.inputResponses && payload.inputResponses.length > 0) {
          throw new Error(
            "Cannot deliver inputResponses — the target session was not found via continuation token.",
          );
        }
        return {
          adapter,
          auth: options.auth,
          capabilities: options.mode === "task" ? undefined : { requestInput: true },
          callback: options.callback,
          channelName: input.channelName,
          continuationToken: namespacedToken,
          delivery,
          initiatorAuth: options.initiatorAuth,
          input: {
            context: payload.context,
            message: serializeUrlFilePartsInMessage(payload.message) ?? "",
            outputSchema: payload.outputSchema,
          },
          mode: options.mode ?? "conversation",
          requestId: metadata.requestId,
          title: options.title,
        };
      };
      return await dispatchOrCreateSession({ command, createRunInput, state });
    },
    async dispatchRoute(command, options) {
      const state = (options as { readonly state?: TState }).state;
      const createRunInput = (adapter: ChannelAdapter<any>): RunInput => ({
        adapter,
        auth: options.auth,
        capabilities: { requestInput: true },
        channelName: input.channelName,
        continuationToken: namespacedToken,
        initialRouteRemote: command,
        initiatorAuth: options.initiatorAuth,
        input: { message: command.message },
        mode: "conversation",
        requestId: metadata.requestId,
        title: options.title,
      });
      return await dispatchOrCreateSession({ command, createRunInput, state });
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
