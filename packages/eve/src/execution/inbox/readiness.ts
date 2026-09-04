import { getWritable } from "#compiled/@workflow/core/index.js";
import { getRun } from "#internal/workflow/runtime.js";
import type { InboxAddress } from "#execution/inbox/types.js";

const OWNER_NAMESPACE = "eve.owner";

/** Publishes the winning owner, including when this start lost its claim. */
export async function publishOwnerStep(address: InboxAddress): Promise<void> {
  "use step";
  const writer = getWritable<InboxAddress>({ namespace: OWNER_NAMESPACE }).getWriter();
  try {
    await writer.write(address);
    await writer.close();
  } finally {
    writer.releaseLock();
  }
}

export async function readStartedOwner(runId: string): Promise<InboxAddress> {
  const run = getRun(runId);
  const stream = run.getReadable<InboxAddress>({ namespace: OWNER_NAMESPACE });
  const reader = stream.getReader();
  try {
    const ready = reader.read().then((result) => {
      if (result.done) throw new Error(`Workflow "${runId}" ended without publishing its owner.`);
      return result.value;
    });
    const failed = run.returnValue.then(
      async () => {
        if ((await stream.getTailIndex()) < 0)
          throw new Error(`Workflow "${runId}" ended without publishing its owner.`);
        return await ready;
      },
      (error: unknown): never => {
        throw error;
      },
    );
    return await Promise.race([ready, failed]);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
