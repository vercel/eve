import {
  type DurableDeliverPayload,
  type SessionAuthContext,
  unwrapDeliverPayload,
} from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { routeProxiedDeliverStep } from "#execution/workflow-steps.js";

export type RoutedAttributedDeliverResult =
  | { readonly kind: "cancel-turn" }
  | {
      readonly kind: "continue";
      readonly remainder: readonly DurableDeliverPayload[] | undefined;
    };

/** Routes descendant-bound responses without discarding each payload's actor. */
export async function routeDeliverToChildren(input: {
  readonly auth?: SessionAuthContext | null;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly payloads: readonly DurableDeliverPayload[];
  readonly sessionState: DurableSessionState;
}): Promise<RoutedAttributedDeliverResult> {
  if (!input.sessionState.hasProxyInputRequests) {
    return { kind: "continue", remainder: input.payloads };
  }

  const remainder: DurableDeliverPayload[] = [];
  for (const attributed of input.payloads) {
    const { auth, payload } = unwrapDeliverPayload(attributed, input.auth);
    const routed = await routeProxiedDeliverStep({
      auth,
      parentWritable: input.parentWritable,
      payload,
      sessionState: input.sessionState,
    });
    if (routed.kind === "cancel-turn") return routed;
    if (routed.remainder !== undefined) {
      remainder.push({ auth, kind: "attributed-deliver-payload", payload: routed.remainder });
    }
  }
  return { kind: "continue", remainder: remainder.length === 0 ? undefined : remainder };
}
