import type { MessageContent } from "#shared/message-content.js";

import type {
  ChannelReceiveContext,
  ChannelRespondOptions,
  ChannelSendOptions,
  ChannelSource,
} from "#channel/channel-operations.js";
import { type Answer, answerSchema } from "#shared/input.js";

export type ObservedChannelDelivery<TState> =
  | (ChannelSendOptions<TState> & { readonly message: MessageContent })
  | (ChannelRespondOptions<TState> & { readonly answers: readonly Answer[] });

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
        async create() {
          throw new Error("This delivery-only mock does not create sessions.");
        },
        async send(message, options) {
          return (await observeDelivery(continuationToken, { ...options, message })) as never;
        },
        async respond(answers, options) {
          return (await observeDelivery(continuationToken, {
            ...options,
            answers: answerSchema.array().parse(answers),
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
