import type { DeliverHookPayload, HookPayload } from "#channel/types.js";
import {
  createSessionDeliveryHook,
  type SessionDeliveryHook,
} from "#execution/session-delivery-hook.js";

export async function sessionDeliveryHookWorkflow(input: {
  readonly nextToken: string;
  readonly token: string;
}): Promise<string[]> {
  "use workflow";

  const bufferedDeliveries: DeliverHookPayload[] = [];
  const deliveryHook = createSessionDeliveryHook(bufferedDeliveries);

  try {
    await deliveryHook.rekey(input.token);
    const pendingDelivery = deliveryHook.next();
    await deliveryHook.rekey(input.nextToken);

    const messages: string[] = [];
    collectMessages(await pendingDelivery, deliveryHook, messages);

    while (messages.length < 2) {
      const buffered = bufferedDeliveries.shift();
      if (buffered !== undefined) {
        appendMessages(buffered, messages);
        continue;
      }

      collectMessages(await deliveryHook.next(), deliveryHook, messages);
    }

    return messages;
  } finally {
    await deliveryHook.dispose();
  }
}

function collectMessages(
  result: IteratorResult<HookPayload>,
  deliveryHook: SessionDeliveryHook,
  messages: string[],
): void {
  deliveryHook.consumeNext();
  if (!result.done && result.value.kind === "deliver") {
    appendMessages(result.value, messages);
  }
}

function appendMessages(delivery: DeliverHookPayload, messages: string[]): void {
  for (const payload of delivery.payloads) {
    if (typeof payload.message === "string") messages.push(payload.message);
  }
}
