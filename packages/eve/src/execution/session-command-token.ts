const SESSION_COMMAND_NAMESPACE = "eve:session";

/** Derives the framework-reserved stable command inbox token for a session. */
export function sessionCommandHookToken(sessionId: string): string {
  return `${SESSION_COMMAND_NAMESPACE}:${sessionId}:inbox`;
}
