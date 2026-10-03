import { buildAdapterContext } from "#channel/adapter-context.js";
import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import { AuthKey } from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { setChannelContext } from "#execution/channel-context.js";
import type { SessionStepState } from "#execution/publish-session-events.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import type { InputResponse } from "#shared/input.js";

/**
 * Some channels answer with ids only their `deliver` hook resolves against
 * channel state, such as Telegram's compact button callbacks. Maps each
 * answer the session can't route as sent through that hook, and keeps what
 * maps to a `routable` request, which human input names (one the held turn
 * waits on, or one the session relays). Every other answer stays as sent for
 * the turn's own `deliver` call.
 */
export async function deliverChannelInputResponses(
  input: SessionStepState & {
    readonly delivery: DeliverHookPayload;
    readonly routable: (response: InputResponse) => boolean;
  },
): Promise<{
  readonly delivery: DeliverHookPayload;
  readonly serializedContext: Record<string, unknown>;
}> {
  const { routable } = input;
  const unrouted = input.delivery.payloads.some(
    (payload) => payload.inputResponses?.some((response) => !routable(response)) === true,
  );
  if (!unrouted) return input;
  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.require(ChannelKey);
  if (adapter.deliver === undefined) return input;

  // The hook sees this delivery's caller, as it does in the turn.
  if (input.delivery.auth !== undefined) ctx.set(AuthKey, input.delivery.auth ?? null);
  // Each hook call edits its own copy of channel state, kept only when it maps
  // to a routable request; an answer put back as sent must stay resolvable.
  let state = adapter.state ?? {};
  let mapped = false;
  const payloads: DeliverPayload[] = [];
  for (const payload of input.delivery.payloads) {
    if (payload.inputResponses === undefined) {
      payloads.push(payload);
      continue;
    }
    const responses: InputResponse[] = [];
    for (const response of payload.inputResponses) {
      if (routable(response)) {
        responses.push(response);
        continue;
      }
      const adapterCtx = buildAdapterContext({ ...adapter, state: structuredClone(state) }, ctx);
      const result = await adapter.deliver(
        { ...payload, inputResponses: [response], message: undefined },
        adapterCtx,
      );
      const routed = result?.inputResponses?.filter(routable) ?? [];
      if (routed.length === 0) {
        responses.push(response);
        continue;
      }
      mapped = true;
      state = adapterCtx.state;
      responses.push(...routed);
    }
    payloads.push({ ...payload, inputResponses: responses });
  }
  if (!mapped) return input;

  // Only the channel state the mapping consumed carries over; the turn applies
  // the rest of this delivery, such as its caller, itself.
  const session = await deserializeContext(input.serializedContext);
  setChannelContext(session, { ...adapter, state });
  return {
    delivery: { ...input.delivery, payloads },
    serializedContext: serializeContext(session),
  };
}
