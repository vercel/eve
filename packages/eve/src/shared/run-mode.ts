/**
 * Execution mode for one runtime-owned run.
 *
 * Conversation runs may park and resume on follow-up input. Task runs must
 * finish within the current invocation and cannot wait for another message.
 */
export type RunMode = "conversation" | "task";
