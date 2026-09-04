const SESSION_COMMAND_NAMESPACE = "eve:session";

/** Returns whether a token belongs to eve's framework-reserved session command namespace. */
export function isReservedSessionCommandToken(token: string): boolean {
  return token.startsWith(`${SESSION_COMMAND_NAMESPACE}:`);
}

/** Returns whether a token is the stable command inbox for one workflow run. */
export function isSessionCommandHookToken(token: string): boolean {
  const prefix = `${SESSION_COMMAND_NAMESPACE}:`;
  const suffix = ":inbox";
  if (!token.startsWith(prefix) || !token.endsWith(suffix)) return false;
  return !token.slice(prefix.length, -suffix.length).includes(":");
}

/** Derives the framework-reserved stable command inbox token for a session. */
export function sessionCommandHookToken(sessionId: string): string {
  return `${SESSION_COMMAND_NAMESPACE}:${sessionId}:inbox`;
}

/** Decodes the framework session address used by durable task producers. */
export function readSessionIdFromCommandToken(token: string): string | undefined {
  if (!isSessionCommandHookToken(token)) return undefined;
  return token.slice(`${SESSION_COMMAND_NAMESPACE}:`.length, -":inbox".length);
}
