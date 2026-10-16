import type { Session } from "#channel/session.js";
import { signInOf, type SignIn } from "#channel/sign-in.js";
import { emptySessionView, foldReceivedEvent } from "#protocol/session-projection/fold.js";
import { openSignIns } from "#protocol/session-reader.js";

// A pending sign-in holds its turn near the tail. Bound button lookups in long-lived threads,
// as on main; the lookup needs only sign-in rows, not a complete conversation projection.
const PENDING_AUTHORIZATION_WINDOW = 500;

/** The latest matching sign-in still open in the recent durable stream. */
export async function findPendingAuthorization(
  session: Pick<Session, "getEventStream">,
  matches: (signIn: SignIn) => boolean,
): Promise<SignIn | undefined> {
  const view = emptySessionView();
  for await (const event of await session.getEventStream({
    follow: false,
    startIndex: -PENDING_AUTHORIZATION_WINDOW,
  })) {
    foldReceivedEvent(view, event);
  }
  return openSignIns(view)
    .map((row) => signInOf(view, row.interactionId)!)
    .findLast(matches);
}
