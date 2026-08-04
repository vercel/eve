import type { ChannelOperations, ChannelSendInput } from "#channel/channel-operations.js";

type SendObserver<TState> = (continuationToken: string, input: ChannelSendInput<TState>) => unknown;

/** Creates channel operations backed by a test-owned send observer. */
export function mockChannelOperations<TState = undefined>(
  observeSend: SendObserver<TState>,
): ChannelOperations<TState> {
  return {
    async send(continuationToken, input) {
      return (await observeSend(continuationToken, input)) as never;
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
    async resolveSession() {
      return undefined;
    },
  };
}
