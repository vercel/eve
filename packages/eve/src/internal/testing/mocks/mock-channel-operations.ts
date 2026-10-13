import type { UserContent } from "ai";

import type {
  ChannelReceiveContext,
  ChannelRespondOptions,
  ChannelSendOptions,
  ChannelSource,
} from "#channel/channel-operations.js";
import { type InputResponse, inputResponseSchema } from "#shared/input.js";

export type ObservedChannelDelivery<TState> =
  | (ChannelSendOptions<TState> & { readonly message: string | UserContent })
  | (ChannelRespondOptions<TState> & { readonly inputResponses: readonly InputResponse[] });

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
      const source: ChannelSource<TState> = {
        async send(message, options) {
          return (await observeDelivery(continuationToken, { ...options, message })) as never;
        },
        async create() {
          return { id: `session:${continuationToken}` } as never;
        },
        async respond(inputResponses, options) {
          return (await observeDelivery(continuationToken, {
            ...options,
            inputResponses: inputResponseSchema.array().parse(inputResponses),
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
      };
      return source;
    },
    async resolveSession() {
      return undefined;
    },
  };
}
