import type { AuthorizationOutcome } from "#protocol/message.js";
import type { ConnectionAuthorizationChallenge } from "#public/connections/errors.js";

type AuthorizationPresentation = Pick<
  ConnectionAuthorizationChallenge,
  "displayName" | "instructions" | "url" | "userCode"
>;

export function authorizationDisplayName(name: string, displayName: string | undefined): string {
  const authoredDisplayName = displayName?.trim();
  if (authoredDisplayName) return authoredDisplayName;
  if (name.length === 0) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function renderAuthorizationRequired(input: {
  readonly authorization?: AuthorizationPresentation;
  readonly description: string;
  readonly includeUrl?: boolean;
  readonly linkStyle?: "markdown" | "plain";
  readonly name: string;
}): string {
  const displayName = authorizationDisplayName(input.name, input.authorization?.displayName);
  const url = input.includeUrl === false ? undefined : input.authorization?.url;
  const signIn =
    url === undefined
      ? undefined
      : input.linkStyle === "markdown"
        ? `[Sign in with ${displayName}](${url})`
        : `Sign in with ${displayName}: ${url}`;
  return [
    `Authorization required for ${displayName}.`,
    input.description,
    input.authorization?.instructions === input.description
      ? undefined
      : input.authorization?.instructions,
    input.authorization?.userCode === undefined
      ? undefined
      : `Code: ${input.authorization.userCode}`,
    signIn,
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n\n");
}

export function renderAuthorizationCompleted(input: {
  readonly authorization?: Pick<AuthorizationPresentation, "displayName">;
  readonly name: string;
  readonly outcome: AuthorizationOutcome;
  readonly reason?: string;
}): string {
  const displayName = authorizationDisplayName(input.name, input.authorization?.displayName);
  if (input.outcome === "authorized") return `${displayName} connected. Resuming.`;
  const outcome = input.outcome === "timed-out" ? "timed out" : input.outcome;
  const reason = input.reason === undefined ? "" : ` (${input.reason})`;
  return `${displayName} authorization ${outcome}${reason}.`;
}
