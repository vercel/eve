// How built-in channels show a sign-in, read from its interaction row. Its challenge (a link, a
// code) is a credential, so it goes only where the person signing in alone reads it: the
// conversation when it's theirs, otherwise privately, with a link-free status in the conversation.
// When the sign-in ends, the status is edited, or the ending posted, and an accepted sign-in shows
// the turn resuming. A sign-in an approval's responder needs has its own prompt.

import { interactionOwner } from "#protocol/session-projection/selectors.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import type {
  InteractionOutcome,
  InteractionSettledData,
} from "#protocol/session-events/families/interaction.js";
import { signInEnding } from "#protocol/session-projection/reader.js";
import { displayProperName } from "#protocol/session-projection/display-name.js";

/** A sign-in as a channel shows it. */
export interface SignIn {
  readonly interactionId: string;
  /** The connection's name, which keys what a channel posted for it. */
  readonly name: string;
  readonly displayName: string;
  readonly url?: string;
  readonly userCode?: string;
  readonly instructions?: string;
  /** The principal that must sign in. */
  readonly principalId?: string;
  /** The approval response whose responder signs in; such a sign-in has its own prompt. */
  readonly responseId?: string;
  /** The turn the sign-in holds. */
  readonly turnId?: string;
}

/** The sign-in an interaction is, or `undefined` for any other interaction. */
export function signInOf(view: SessionView, interactionId: string): SignIn | undefined {
  const row = view.interactions[interactionId];
  if (row === undefined || row.request.kind !== "sign-in") return undefined;
  const challenge = row.request.signIn;
  const name = challenge?.name ?? interactionId;
  const principalId = row.audience?.principalIds[0];
  const turnId = interactionOwner(view, row).turnId;
  return {
    displayName: challenge?.displayName ?? displayProperName(name),
    interactionId,
    name,
    ...(challenge?.url !== undefined && { url: challenge.url }),
    ...(challenge?.userCode !== undefined && { userCode: challenge.userCode }),
    ...(challenge?.instructions !== undefined && { instructions: challenge.instructions }),
    ...(principalId !== undefined && { principalId }),
    ...("responseId" in row.subject && { responseId: row.subject.responseId }),
    ...(turnId !== undefined && { turnId }),
  };
}

/** The challenge as text: what to open or enter. Only its person may read it. */
export function signInChallengeText(signIn: SignIn): string {
  return [
    `Authorization required for ${signIn.displayName}.`,
    signIn.instructions,
    signIn.userCode === undefined ? undefined : `Code: ${signIn.userCode}`,
    signIn.url,
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n\n");
}

/** How a sign-in ended, for the conversation. */
export function signInEndedText(input: {
  readonly displayName: string;
  readonly outcome: InteractionOutcome;
  readonly reason?: string;
}): string {
  if (input.outcome === "accepted") return `${input.displayName} connected.`;
  if (input.outcome === "declined") return `${input.displayName} sign-in cancelled.`;
  const reason = input.reason === undefined ? "" : ` (${input.reason})`;
  return `${input.displayName} sign-in ${signInEnding(input.outcome)}${reason}.`;
}

/** What a channel can do for a sign-in. */
export interface SignInSurface {
  /** Only the person signing in reads the conversation, so the challenge can go in it. */
  readonly private: boolean;
  /** Posts the challenge in a private conversation; the posted message's id, if it can edit it. */
  postChallenge(signIn: SignIn): Promise<string | undefined>;
  /** Shows the challenge to its person alone, outside the conversation; false when it can't. */
  deliverPrivately?(signIn: SignIn): Promise<boolean>;
  /** Posts text in the conversation; the posted message's id, if it can edit it. */
  post(text: string): Promise<string | undefined>;
  /** Posts the link-free status its own way, instead of as the default text. */
  postStatus?(signIn: SignIn, delivered: boolean): Promise<string | undefined>;
  /** Replaces a posted message's text. Without it, an ending posts as a new message. */
  edit?(messageId: string, text: string): Promise<void>;
  /** Shows the turn working again. */
  typing?(status: string): Promise<void>;
  /**
   * What the channel posted for each open sign-in, by connection name, kept in its state: the
   * message to edit, or `""` for one it can't.
   */
  readonly posted: {
    get(name: string): string | undefined;
    set(name: string, messageId: string | undefined): void;
  };
}

/** Shows a sign-in once, where its challenge stays with its person. */
export async function showSignIn(
  view: SessionView,
  interactionId: string,
  surface: SignInSurface,
): Promise<void> {
  const signIn = signInOf(view, interactionId);
  if (signIn === undefined || signIn.responseId !== undefined) return;
  if (surface.posted.get(signIn.name) !== undefined) return;
  let posted: string | undefined;
  if (surface.private) {
    posted = await surface.postChallenge(signIn);
  } else {
    const delivered = (await surface.deliverPrivately?.(signIn)) === true;
    posted =
      surface.postStatus === undefined
        ? await surface.post(
            delivered
              ? `Authorization required for ${signIn.displayName}. I sent you the sign-in details privately.`
              : `Authorization required for ${signIn.displayName}. Continue in a direct message with this agent.`,
          )
        : await surface.postStatus(signIn, delivered);
  }
  surface.posted.set(signIn.name, posted ?? "");
}

/** Shows how a sign-in the channel showed ended, and the turn resuming once it's accepted. */
export async function settleSignIn(
  view: SessionView,
  data: InteractionSettledData,
  surface: SignInSurface,
): Promise<void> {
  const signIn = signInOf(view, data.interactionId);
  if (signIn === undefined || signIn.responseId !== undefined) return;
  const posted = surface.posted.get(signIn.name);
  if (posted === undefined) return;
  surface.posted.set(signIn.name, undefined);
  const text = signInEndedText({ ...signIn, outcome: data.outcome, reason: data.reason });
  if (posted !== "" && surface.edit !== undefined) await surface.edit(posted, text);
  else await surface.post(text);
  if (data.outcome === "accepted") await surface.typing?.("Connected. Resuming...");
}

/** A `posted` record over a map of message ids by connection name in a channel's state. */
export function postedIn<K extends string>(
  state: { [P in K]?: Record<string, string> | undefined },
  key: K,
): SignInSurface["posted"] {
  return {
    get: (name) => state[key]?.[name],
    set(name, messageId) {
      const { [name]: _previous, ...rest } = state[key] ?? {};
      (state as Record<K, Record<string, string>>)[key] =
        messageId === undefined ? rest : { ...rest, [name]: messageId };
    },
  };
}
