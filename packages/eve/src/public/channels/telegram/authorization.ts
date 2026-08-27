import type { AuthorizationOutcome, AuthorizationRequiredStreamEvent } from "#protocol/message.js";

export const TELEGRAM_AUTHORIZATION_CALLBACK_PREFIX = "eve_auth:";

export function renderTelegramAuthorizationPrompt(
  authorization: AuthorizationRequiredStreamEvent["data"],
): { readonly reply_markup?: Readonly<Record<string, unknown>>; readonly text: string } {
  const displayName = formatTelegramAuthorizationDisplayName(
    authorization.name,
    authorization.authorization?.displayName,
  );
  const url = authorization.authorization?.url;
  return {
    reply_markup:
      url === undefined
        ? undefined
        : { inline_keyboard: [[{ text: `Sign in with ${displayName}`, url }]] },
    text: [
      `Authorization required for ${displayName}.`,
      authorization.authorization?.instructions,
      authorization.authorization?.userCode === undefined
        ? undefined
        : `Code: ${authorization.authorization.userCode}`,
    ]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join("\n\n"),
  };
}

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
        : {
            inline_keyboard: [[{ callback_data: callbackData, text: "Authorize" }]],
          },
    text: `Authorization required for ${input.displayName}. The requester must sign in to resume.`,
  };
}

export function formatTelegramAuthorizationDisplayName(
  name: string,
  displayName: string | undefined,
): string {
  if (displayName !== undefined) return displayName;
  if (name.length === 0) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function renderTelegramAuthorizationCompleted(input: {
  readonly displayName: string;
  readonly outcome: AuthorizationOutcome;
  readonly reason?: string;
}): string {
  if (input.outcome === "authorized") return `${input.displayName} connected.`;
  const reason = input.reason === undefined ? "" : ` (${input.reason})`;
  const outcome = input.outcome === "timed-out" ? "timed out" : input.outcome;
  return `${input.displayName} authorization ${outcome}${reason}.`;
}
