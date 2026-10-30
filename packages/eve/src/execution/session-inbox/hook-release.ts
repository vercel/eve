import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { findSessionHookHolder } from "#execution/session-inbox/owner.js";
import { requireSessionId } from "#execution/session-inbox/resume.js";

/** Longest ingress waits for a session hook to change hands. */
export const SESSION_HOOK_HANDOVER_TIMEOUT_MS = 30_000;

/**
 * Waits until no run serving `session` holds any of the logical addresses. A
 * handoff successor serves the same session, so only the session's end (or
 * an unrelated run claiming the address afterwards) satisfies the wait.
 */
export async function waitForSessionHooksRelease(
  logicalTokens: Iterable<string>,
  session: { readonly ownerRunId: string; readonly sessionId: string },
): Promise<void> {
  await Promise.all(
    [...new Set(logicalTokens)].map((token) =>
      waitForHookRelease(sessionInboxHookToken(token), session),
    ),
  );
}

async function waitForHookRelease(
  token: string,
  session: { readonly ownerRunId: string; readonly sessionId: string },
): Promise<void> {
  const deadline = Date.now() + SESSION_HOOK_HANDOVER_TIMEOUT_MS;
  while (true) {
    if (!(await servesSession(token, session))) return;

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for session "${session.sessionId}" to release inbox "${token}".`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function servesSession(
  token: string,
  session: { readonly ownerRunId: string; readonly sessionId: string },
): Promise<boolean> {
  const holder = await findSessionHookHolder(token);
  if (holder === undefined) return false;
  try {
    if (holder.hook !== undefined)
      return requireSessionId(await holder.hook.metadata) === session.sessionId;
  } catch {
    // Unreadable metadata says nothing about the holder; fall through to its id.
  }
  return holder.runId === session.ownerRunId;
}
