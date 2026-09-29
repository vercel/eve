import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";

/**
 * Which run messages the session may write while a model step owns its state,
 * leaving their dispatch pending for the next step that owns it. A kind
 * qualifies only when producing its event changes no session state. Its event
 * must also:
 *
 * - allow its delivery to follow its write (`WritableBeforeDispatchEvent`);
 * - be ignored by instrumentation and session activity, because a pending
 *   dispatch reaches only the channel adapter and hooks, and an event nothing
 *   subscribes to is never dispatched.
 */
const EARLY_WRITE = {
  // Opening a session changes nothing this session records.
  "agent-started": true,
  // Producing a task's event means updating the task table it reports.
  started: false,
  reply: false,
  usage: false,
  // Settles a call the turn waits on, or a task.
  outcome: false,
  // Qualifies, but writing progress mid-step would change when clients see it.
  report: false,
  // Records the question or sign-in the session relays.
  request: false,
  // Withdraws a question the session recorded.
  withdraw: false,
} as const satisfies { readonly [K in WorkflowToolRunMessage["kind"]]: boolean };

type EarlyWritableKind = {
  [K in keyof typeof EARLY_WRITE]: (typeof EARLY_WRITE)[K] extends true ? K : never;
}[keyof typeof EARLY_WRITE];

/** A run message whose event the session may write before dispatching it. */
export type EarlyWritableRunMessage = Extract<
  WorkflowToolRunMessage,
  { readonly kind: EarlyWritableKind }
>;

export function isEarlyWritableRunMessage(
  message: WorkflowToolRunMessage,
): message is EarlyWritableRunMessage {
  return EARLY_WRITE[message.kind];
}
