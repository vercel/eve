import { createHook, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { DeliverPayload } from "#channel/types.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";

/**
 * Models the parked-session consumer shipped in eve 0.30.5–0.30.8.
 *
 * Frozen copy of that cohort's inbox decode (`waitForNextSessionAction` +
 * `commandToDelivery` at 0.30.7): every payload that is not a control kind is
 * cast to a `send` command and re-wrapped by reading its `payload` field. A
 * producer envelope without that field therefore delivers `undefined` and the
 * message is lost. This cohort also owns the stable session inbox, which is
 * the markerless capability the current producer uses to select raw `send`.
 */
export async function midCohortSessionDeliveryWorkflow(input: {
  readonly token: string;
}): Promise<string> {
  "use workflow";

  createHook({ token: sessionCommandHookToken(getWorkflowMetadata().workflowRunId) });
  const inbox = createHook<{ readonly kind: string }>({ token: input.token });
  for await (const value of inbox) {
    if (
      value.kind === "session-timeout" ||
      value.kind === "clear" ||
      value.kind === "compact" ||
      value.kind === "reset" ||
      value.kind === "cancel"
    ) {
      continue;
    }

    const command = value as { readonly payload?: DeliverPayload };
    const payloads = [command.payload];
    const message = payloads[0]?.message;
    return typeof message === "string" ? message : "";
  }
  return "";
}
