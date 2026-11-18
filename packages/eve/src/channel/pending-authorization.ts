import type { Session } from "#channel/session.js";
import { signInOf, type SignIn } from "#channel/sign-in.js";
import { emptySessionView, foldReceivedEvent } from "#protocol/session-projection/fold.js";
import { openSignIns } from "#protocol/session-projection/reader.js";

const PENDING_AUTHORIZATION_WINDOW = 500;

export async function findPendingAuthorization(
  session: Pick<Session, "stream">,
  matches: (signIn: SignIn) => boolean,
): Promise<SignIn | undefined> {
  const view = emptySessionView();
  for await (const event of session.stream({
    follow: false,
    startIndex: -PENDING_AUTHORIZATION_WINDOW,
  })) {
    foldReceivedEvent(view, event);
  }
  return openSignIns(view)
    .map((row) => signInOf(view, row.interactionId)!)
    .findLast(matches);
}
