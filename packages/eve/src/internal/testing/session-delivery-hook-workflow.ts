import type { DeliverHookPayload, HookPayload } from "#channel/types.js";
import { createSessionInputQueue, type SessionInputQueue } from "#execution/session-input-queue.js";

export async function sessionDeliveryHookWorkflow(input: {
  readonly nextToken: string;
  readonly token: string;
}): Promise<string[]> {
  "use workflow";

  const inputQueue = createSessionInputQueue();

  try {
    await inputQueue.rekey(input.token);
    const pendingDelivery = inputQueue.nextAdmission();
    await inputQueue.rekey(input.nextToken);

    const messages: string[] = [];
    collectMessages(await pendingDelivery, inputQueue, messages);

    while (messages.length < 2) {
      const next = await inputQueue.takeNextTurn();
      if (next === null) break;
      appendMessages(next, messages);
    }

    return messages;
  } finally {
    await inputQueue.dispose();
  }
}

function collectMessages(
  result: IteratorResult<HookPayload>,
  inputQueue: SessionInputQueue,
  messages: string[],
): void {
  inputQueue.consumeAdmission();
  if (!result.done && result.value.kind === "deliver") {
    appendMessages(result.value, messages);
  }
}

function appendMessages(delivery: DeliverHookPayload, messages: string[]): void {
  for (const payload of delivery.payloads) {
    if (typeof payload.message === "string") messages.push(payload.message);
  }
}
