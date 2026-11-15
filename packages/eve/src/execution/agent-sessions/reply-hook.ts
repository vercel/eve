import { isObject } from "#shared/guards.js";

/**
 * Marks the hook a run awaits an agent's reply on. eve's callback route is unauthenticated, so
 * it resumes only a hook that carries this mark: never a session inbox, or a hook authored code
 * created with `createHook()`, whose token may be guessable.
 */
export const AGENT_REPLY_HOOK_METADATA = { eveAgentReply: true } as const;

/** Whether `metadata` is that of a hook a run awaits an agent's reply on. */
export function isAgentReplyHookMetadata(metadata: unknown): boolean {
  return isObject(metadata) && metadata.eveAgentReply === true;
}
