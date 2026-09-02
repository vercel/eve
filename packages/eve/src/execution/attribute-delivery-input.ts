import type { ChannelAdapter, ChannelAdapterContext } from "#channel/adapter.js";
import { defaultDeliverResult } from "#channel/adapter.js";
import type { DeliverHookPayload } from "#channel/types.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import type { StepInput } from "#harness/types.js";

/**
 * Runs the adapter's deliver hook for each queued payload and coalesces the
 * results into one step input. Each payload's responses are bound to the
 * responder and delivery that carried them so the harness can settle
 * approvals per responder and dedupe per delivery. A text message keeps the
 * delivery auth unless the adapter already attributed it.
 */
export async function deliverAttributedStepInput(input: {
  readonly adapter: ChannelAdapter<ChannelAdapterContext<any>>;
  readonly adapterCtx: ChannelAdapterContext<any>;
  readonly delivery: DeliverHookPayload;
}): Promise<StepInput | undefined> {
  const auth = input.delivery.auth ?? null;
  const results: StepInput[] = [];
  for (const [payloadIndex, payload] of input.delivery.payloads.entries()) {
    const result = input.adapter.deliver
      ? await input.adapter.deliver(payload, input.adapterCtx)
      : defaultDeliverResult(payload);
    if (result === undefined || result === null) continue;

    const deliveryId = input.delivery.deliveryMetadata?.find(
      (entry) => entry.payloadIndex === payloadIndex,
    )?.deliveryId;
    results.push({
      ...result,
      attributedInputResponses: [
        ...(result.attributedInputResponses ?? []),
        ...(result.inputResponses ?? []).map((response) => ({ auth, deliveryId, response })),
      ],
      inputResponses: undefined,
      messageAuth:
        result.message === undefined
          ? result.messageAuth
          : (input.delivery.auth ?? result.messageAuth ?? null),
    });
  }
  return results.length === 0 ? undefined : results.reduce(coalesceTurnInputs);
}
