import { foldRunUsage, forgetRunUsage } from "#execution/agent-sessions/usage.js";
import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";

/**
 * Applies a run's usage report to the session's totals, or, on the run's
 * outcome, forgets the reports it applied from that run.
 */
export async function applyRunUsageStep(input: {
  readonly message: Extract<WorkflowToolRunMessage, { readonly kind: "outcome" | "usage" }>;
  readonly sessionState: DurableSessionState;
}): Promise<{ readonly sessionState: DurableSessionState }> {
  "use step";

  const { message } = input;
  const session = readDurableSession(input.sessionState);
  const next =
    message.kind === "usage"
      ? foldRunUsage(session, message)
      : forgetRunUsage(session, message.from.runId);
  return {
    sessionState: replaceDurableSessionSnapshot({ session: next, state: input.sessionState }),
  };
}
