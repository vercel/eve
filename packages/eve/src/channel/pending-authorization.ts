import type { Session } from "#channel/session.js";
import type { AuthorizationRequiredStreamEvent } from "#protocol/message.js";

type AuthorizationRequired = AuthorizationRequiredStreamEvent["data"];

/**
 * How many recent events a lookup reads. A pending sign-in holds its turn, so
 * it sits near the tail; reading a bounded window keeps a press in a
 * long-lived thread from replaying the whole session.
 */
const PENDING_AUTHORIZATION_WINDOW = 500;

/**
 * The newest sign-in that `matches` and hasn't completed yet, from the
 * session's recent events. Attempts are keyed by connection name and
 * `attemptId`, so one attempt completing never hides another still pending.
 */
export async function findPendingAuthorization(
  session: Pick<Session, "getEventStream">,
  matches: (event: AuthorizationRequired) => boolean,
): Promise<AuthorizationRequired | undefined> {
  const pending = new Map<string, AuthorizationRequired>();
  const reader = (
    await session.getEventStream({ follow: false, startIndex: -PENDING_AUTHORIZATION_WINDOW })
  ).getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const event = next.value;
      if (event.type === "authorization.required" && matches(event.data)) {
        const key = attemptKey(event.data);
        pending.delete(key);
        pending.set(key, event.data);
      } else if (event.type === "authorization.completed") {
        pending.delete(attemptKey(event.data));
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return [...pending.values()].at(-1);
}

function attemptKey(event: { readonly attemptId?: string; readonly name: string }): string {
  return JSON.stringify([event.name, event.attemptId ?? null]);
}
