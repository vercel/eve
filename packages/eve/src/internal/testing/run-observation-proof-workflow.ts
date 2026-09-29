import { createHook, getWritable, sleep } from "#compiled/@workflow/core/index.js";
import {
  createTurnStartedEvent,
  encodeMessageStreamEvent,
  stampMessageStreamEvent,
} from "#protocol/message.js";

import { claimHookOwnership, isHookConflictError } from "#execution/hook-ownership.js";

export async function runObservationConcurrencyProof(input: {
  readonly ownerToken: string;
  readonly emitStreamEvent?: boolean;
}): Promise<{ readonly owner: boolean; readonly observations: number }> {
  "use workflow";

  const ownership = createHook({ token: input.ownerToken });
  try {
    await claimHookOwnership(ownership);
  } catch (error) {
    if (isHookConflictError(error)) return { owner: false, observations: 0 };
    throw error;
  }

  let observations = 0;
  const writable = input.emitStreamEvent ? getWritable<Uint8Array>() : undefined;
  try {
    const observe = async () => {
      for (let index = 0; index < 3; index++) {
        observations = await recordObservationStep(observations, writable);
        await sleep("100ms");
      }
    };
    const deliver = async () => {
      await recordDeliveryStep();
    };
    await Promise.all([observe(), deliver()]);
    return { owner: true, observations };
  } finally {
    await ownership.dispose();
  }
}

async function recordObservationStep(
  previous: number,
  writable?: WritableStream<Uint8Array>,
): Promise<number> {
  "use step";
  if (writable !== undefined) {
    const writer = writable.getWriter();
    try {
      await writer.write(
        encodeMessageStreamEvent(
          stampMessageStreamEvent(
            createTurnStartedEvent({ sequence: previous, turnId: `turn-${previous}` }),
          ),
        ),
      );
    } finally {
      writer.releaseLock();
    }
  }
  return previous + 1;
}

async function recordDeliveryStep(): Promise<void> {
  "use step";
  await new Promise((resolve) => setTimeout(resolve, 1_500));
}
