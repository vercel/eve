const SESSION_COMMAND_NAMESPACE = "eve:session";

/** Returns whether a token belongs to eve's framework-reserved session command namespace. */
export function isReservedSessionCommandToken(token: string): boolean {
  return token.startsWith(`${SESSION_COMMAND_NAMESPACE}:`);
}

/** Derives a stable session command address, resolved directly without a hook lookup. */
export function sessionCommandToken(sessionId: string): string {
  return `${SESSION_COMMAND_NAMESPACE}:${sessionId}:inbox`;
}

/** Decodes the framework session address used by durable task producers. */
export function readSessionIdFromCommandToken(token: string): string | undefined {
  const prefix = `${SESSION_COMMAND_NAMESPACE}:`;
  const suffix = ":inbox";
  if (!token.startsWith(prefix) || !token.endsWith(suffix)) return undefined;
  const sessionId = token.slice(prefix.length, -suffix.length);
  return sessionId.length > 0 && !sessionId.includes(":") ? sessionId : undefined;
}
