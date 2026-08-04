const SESSION_COMMAND_NAMESPACE = "eve:session";

/** Returns whether a token belongs to eve's framework-reserved session command namespace. */
export function isReservedSessionCommandToken(token: string): boolean {
  return token.startsWith(`${SESSION_COMMAND_NAMESPACE}:`);
}

/** Derives the framework-reserved stable command inbox token for a session. */
export function sessionCommandHookToken(sessionId: string): string {
  return `${SESSION_COMMAND_NAMESPACE}:${sessionId}:inbox`;
}
