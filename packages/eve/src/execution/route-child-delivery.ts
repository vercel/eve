import type { AttributedDeliverPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { routeProxiedDeliverStep } from "#execution/workflow-steps.js";

export type RoutedAttributedDeliverResult =
  | { readonly kind: "cancel-turn" }
  | {
      readonly kind: "continue";
      readonly remainder: readonly AttributedDeliverPayload[] | undefined;
    };

/** Routes descendant-bound responses without discarding each payload's actor. */
export async function routeDeliverToChildren(input: {
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly payloads: readonly AttributedDeliverPayload[];
  readonly sessionState: DurableSessionState;
}): Promise<RoutedAttributedDeliverResult> {
  if (!input.sessionState.hasProxyInputRequests) {
    return { kind: "continue", remainder: input.payloads };
  }

  return routeProxiedDeliverStep(input);
}
