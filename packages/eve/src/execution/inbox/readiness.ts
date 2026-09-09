import { getWritable } from "#compiled/@workflow/core/index.js";
import { readStreamRecord } from "#execution/session/stream-storage.js";
import { encodeStreamLocation } from "#execution/session/stream-location.js";
import type { InboxAddress } from "#execution/inbox/types.js";
import { getRawHookByToken } from "#internal/workflow/runtime.js";
import { awaitInboxClaim } from "#execution/inbox/startup.js";

const OWNER_NAMESPACE = "eve.owner";

export async function readClaimedOwner(token: string): Promise<InboxAddress> {
  const hook = await awaitInboxClaim(() => getRawHookByToken(token));
  return { token, ownerRunId: hook.runId };
}

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
  return await readStreamRecord<InboxAddress>(
    encodeStreamLocation({ runId, namespace: OWNER_NAMESPACE }),
  );
}
