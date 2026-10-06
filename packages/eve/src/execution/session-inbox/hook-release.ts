import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { findSessionHookHolder } from "#execution/session-inbox/owner.js";

/** Longest ingress waits for a session hook to change hands. */
export const SESSION_HOOK_HANDOVER_TIMEOUT_MS = 30_000;

/** Waits until none of the logical session addresses belongs to `ownerRunId` any more. */
export async function waitForSessionHooksRelease(
  logicalTokens: Iterable<string>,
  ownerRunId: string,
): Promise<void> {
  await Promise.all(
    [...new Set(logicalTokens)].map((token) =>
      waitForHookRelease(sessionInboxHookToken(token), ownerRunId),
    ),
  );
}

async function waitForHookRelease(token: string, ownerRunId: string): Promise<void> {
  const deadline = Date.now() + SESSION_HOOK_HANDOVER_TIMEOUT_MS;
  while (true) {
    if ((await findSessionHookHolder(token))?.runId !== ownerRunId) return;

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for session "${ownerRunId}" to release inbox "${token}".`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}
