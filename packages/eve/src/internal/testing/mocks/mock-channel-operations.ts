import type { UserContent } from "ai";

import type {
  ChannelReceiveContext,
  ChannelRespondOptions,
  ChannelSendOptions,
  InternalChannelSource,
} from "#channel/channel-operations.js";
import { INTERNAL_CHANNEL_DELIVER } from "#channel/channel-operations.js";
import type { InputResponse } from "#runtime/input/types.js";

export type ObservedChannelDelivery<TState> =
  | (ChannelSendOptions<TState> & { readonly message: string | UserContent })
  | (ChannelRespondOptions & { readonly inputResponses: readonly InputResponse[] });

type DeliveryObserver<TState> = (
  continuationToken: string,
  input: ObservedChannelDelivery<TState>,
) => unknown;

/** Creates a channel receive context backed by a test-owned delivery observer. */
export function mockChannelContext<TState = undefined>(
  observeDelivery: DeliveryObserver<TState>,
): ChannelReceiveContext<TState> {
  return {
    from(continuationToken) {
      const source: InternalChannelSource<TState> = {
        async send(message, options) {
          return (await observeDelivery(continuationToken, { ...options, message })) as never;
        },
        async respond(inputResponses, options) {
          return (await observeDelivery(continuationToken, {
            ...options,
            inputResponses,
          })) as never;
        },
        async cancel() {
          return { status: "no_active_turn" } as never;
        },
        async compact() {
          return { status: "no_active_session" } as never;
        },
        async clear() {
          return { status: "no_active_session" } as never;
        },
        async reset() {
          return { status: "no_active_session" } as never;
        },
        async [INTERNAL_CHANNEL_DELIVER](payload, options) {
          return (await observeDelivery(continuationToken, {
            ...options,
            ...payload,
          } as ObservedChannelDelivery<TState>)) as never;
        },
      };
      return source;
    },
    async resolveSession() {
      return undefined;
    },
  };
}
