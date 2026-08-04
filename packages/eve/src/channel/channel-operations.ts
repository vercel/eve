import type { ChannelAdapter } from "#channel/adapter.js";
import { createChannelAddressFn } from "#channel/channel-address.js";
import type { SendPayload } from "#channel/routes.js";
import type { Session } from "#channel/session.js";
import type {
  CancelTurnResult,
  ClearSessionResult,
  CompactSessionResult,
  ResetSessionResult,
  Runtime,
  SessionAuthContext,
  SessionCallback,
} from "#channel/types.js";
import type { RunMode } from "#shared/run-mode.js";

interface BaseChannelSendInput extends SendPayload {
  readonly auth: SessionAuthContext | null;
  readonly callback?: SessionCallback;
  readonly initiatorAuth?: SessionAuthContext | null;
  readonly mode?: RunMode;
  readonly title?: string;
}

/** Message, authorization, and creation options for one channel-local send. */
export type ChannelSendInput<TState = undefined> = [TState] extends [undefined]
  ? BaseChannelSendInput
  : BaseChannelSendInput & { readonly state: TState };

/**
 * Request-scoped operations targeting channel-local continuation addresses.
 * Only `send` may create a session when an address is unowned.
 */
export interface ChannelOperations<TState = undefined> {
  /** Starts or resumes the session owning a raw channel-local address. */
  send(address: string, input: ChannelSendInput<TState>): Promise<Session>;
  /** Cooperatively cancels the active turn at an address without creating a session. */
  cancel(address: string, options?: { readonly turnId?: string }): Promise<CancelTurnResult>;
  /** Queues context compaction at an address without creating a session. */
  compact(address: string): Promise<CompactSessionResult>;
  /** Clears model-message history at an address without creating a session. */
  clear(address: string): Promise<ClearSessionResult>;
  /** Retires the session owning an address without creating a replacement. */
  reset(address: string, options?: { readonly reason?: string }): Promise<ResetSessionResult>;
  /** Snapshots the current address owner as a fixed session handle. */
  resolveSession(address: string): Promise<Session | undefined>;
}

/** Creates request-scoped channel operations backed by continuation dispatch. */
export function createChannelOperations<TState = undefined>(input: {
  readonly adapter: ChannelAdapter<any>;
  readonly channelName: string;
  readonly metadata?: { readonly requestId?: string };
  readonly runtime: Runtime;
}): ChannelOperations<TState> {
  const channelAddress = createChannelAddressFn<TState>(input);

  return {
    async send(address, sendInput) {
      return await channelAddress(address).send(
        {
          context: sendInput.context,
          inputResponses: sendInput.inputResponses,
          message: sendInput.message,
          outputSchema: sendInput.outputSchema,
        },
        sendInput,
      );
    },
    async cancel(address, options) {
      return await channelAddress(address).cancel(options);
    },
    async compact(address) {
      return await channelAddress(address).compact();
    },
    async clear(address) {
      return await channelAddress(address).clear();
    },
    async reset(address, options) {
      return await channelAddress(address).reset(options);
    },
    async resolveSession(address) {
      return await channelAddress(address).resolveSession();
    },
  };
}
