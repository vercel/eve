import type { SignIn } from "#channel/sign-in.js";

export const TELEGRAM_AUTHORIZATION_CALLBACK_PREFIX = "eve_auth:";

/** The sign-in prompt for its person: what to do, and a button that opens the sign-in link. */
export function renderTelegramAuthorizationPrompt(
  signIn: Pick<SignIn, "displayName" | "instructions" | "url" | "userCode">,
): { readonly reply_markup?: Readonly<Record<string, unknown>>; readonly text: string } {
  const { displayName, url } = signIn;
  return {
    reply_markup:
      url === undefined
        ? undefined
        : { inline_keyboard: [[{ text: `Sign in with ${displayName}`, url }]] },
    text: [
      `Authorization required for ${displayName}.`,
      signIn.instructions,
      signIn.userCode === undefined ? undefined : `Code: ${signIn.userCode}`,
    ]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join("\n\n"),
  };
}

/** A group's link-free status, whose button sends the requester the prompt privately. */
export function renderTelegramAuthorizationStatus(input: {
  readonly displayName: string;
  readonly requesterUserId?: string | null;
}): { readonly reply_markup?: Readonly<Record<string, unknown>>; readonly text: string } {
  const callbackData =
    input.requesterUserId === undefined || input.requesterUserId === null
      ? undefined
      : `${TELEGRAM_AUTHORIZATION_CALLBACK_PREFIX}${input.requesterUserId}`;
  return {
    reply_markup:
      callbackData === undefined
        ? undefined
        : { inline_keyboard: [[{ callback_data: callbackData, text: "Authorize" }]] },
    text: `Authorization required for ${input.displayName}. The requester must sign in to resume.`,
  };
}
