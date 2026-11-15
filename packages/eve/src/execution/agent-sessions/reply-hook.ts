const AGENT_REPLY_HOOK_TOKEN_PREFIX = "eve:reply:v1:";

/**
 * Token of the hook a run awaits an agent's reply on. `id` is the token's only secret, so it
 * must be hard to guess. The prefix is reserved: eve's callback route is unauthenticated and
 * resumes only a token that carries it, never a session inbox or a hook authored code named
 * with `createHook()`.
 */
export function agentReplyHookToken(id: string): string {
  return `${AGENT_REPLY_HOOK_TOKEN_PREFIX}${id}`;
}

/** Whether `token` names a hook a run awaits an agent's reply on. */
export function isAgentReplyHookToken(token: string): boolean {
  return token.startsWith(AGENT_REPLY_HOOK_TOKEN_PREFIX);
}
