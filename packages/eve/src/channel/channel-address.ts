import type { UserContent } from "ai";

import type { ChannelAdapter } from "#channel/adapter.js";
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
} from "#channel/types.js";
import { isRuntimeSessionOwnershipConflictError } from "#execution/runtime-errors.js";
import { isReservedSessionCommandToken } from "#execution/session-command-token.js";
import type { RunMode } from "#shared/run-mode.js";

interface BaseChannelAddressDeliveryOptions {
  readonly auth: SessionAuthContext | null;
  readonly callback?: SessionCallback;
  readonly initiatorAuth?: SessionAuthContext | null;
  readonly mode?: RunMode;
  readonly title?: string;
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

/** Factory for binding a route-local continuation token to a {@link ChannelAddress}. */
export type ChannelAddressFn<TState = undefined> = (
  continuationToken: string,
) => ChannelAddress<TState>;

/** Creates one channel address backed by the runtime's continuation dispatch primitive. */
export function createChannelAddress<TState = undefined>(input: {
  readonly adapter: ChannelAdapter<any>;
  readonly channelName: string;
  readonly continuationToken: string;
  readonly metadata?: { readonly requestId?: string };
  readonly runtime: Runtime;
}): ChannelAddress<TState> {
  const metadata = input.metadata ?? {};
  const namespacedToken = `${input.channelName}:${input.continuationToken}`;
  if (isReservedSessionCommandToken(namespacedToken)) {
    throw new Error(`Channel address "${namespacedToken}" uses eve's reserved session namespace.`);
  }

  return {
    continuationToken: input.continuationToken,
    async deliver(sendInput, options) {
      const payload = normalizeSendInput(sendInput);
      const state = (options as { readonly state?: TState }).state;
      const caller = sessionCallbackToTurnCaller(options.callback);
      const commandWithoutCaller = {
        ...(state === undefined
          ? {}
          : { adapterState: state as Readonly<Record<string, unknown>> }),
        auth: options.auth,
        kind: "send" as const,
        payload: {
          ...payload,
          message: serializeUrlFilePartsInMessage(payload.message),
        },
        requestId: metadata.requestId,
      };
      const command: Extract<SessionCommand, { readonly kind: "send" }> =
        caller === undefined ? commandWithoutCaller : { ...commandWithoutCaller, caller };
      const dispatch = async (): Promise<Session | undefined> => {
        const result = await input.runtime.dispatchContinuation({
          command,
          continuationToken: namespacedToken,
        });
        return result.status === "accepted"
          ? createSession(result.sessionId, input.runtime, metadata)
          : undefined;
      };

      const existing = await dispatch();
      if (existing !== undefined) return existing;
      if (payload.inputResponses && payload.inputResponses.length > 0) {
        throw new Error(
          "Cannot deliver inputResponses — the target session was not found via continuation token.",
        );
      }

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
        capabilities: options.mode === "task" ? undefined : { requestInput: true },
        callback: options.callback,
        channelName: input.channelName,
        continuationToken: namespacedToken,
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
      try {
        const handle = await input.runtime.createSession(runInput);
        return createSession(handle.sessionId, input.runtime, metadata);
      } catch (error) {
        if (!isRuntimeSessionOwnershipConflictError(error)) throw error;
        const winner = await dispatch();
        if (winner !== undefined) return winner;
        throw error;
      }
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
        : createSession(owner.sessionId, input.runtime, metadata);
    },
  };
}

/** Builds a request-scoped factory for channel addresses on one authored channel. */
export function createChannelAddressFn<TState = undefined>(input: {
  readonly adapter: ChannelAdapter<any>;
  readonly channelName: string;
  readonly metadata?: { readonly requestId?: string };
  readonly runtime: Runtime;
}): ChannelAddressFn<TState> {
  return (continuationToken) => createChannelAddress({ ...input, continuationToken });
}
