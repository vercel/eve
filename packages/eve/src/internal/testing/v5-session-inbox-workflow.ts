import { createHook, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { sessionInboxWire } from "#internal/testing/v5-session-inbox-wire.js";

/** A pinned parent with the decoder and capability stamp from before task cancellation. */
export async function v5SessionInboxWorkflow(input: { readonly token: string }): Promise<string[]> {
  "use workflow";

  const metadata = { sessionInboxWireVersion: 5 };
  using stable = createHook({
    metadata,
    token: sessionCommandHookToken(getWorkflowMetadata().workflowRunId),
  });
  using alias = createHook({ metadata, token: input.token });
  await Promise.all([stable.getConflict(), alias.getConflict()]);
  const messages: string[] = [];
  for await (const payload of alias) {
    const command = sessionInboxWire.decode(payload);
    if (command.kind === "deliver") {
      for (const delivery of command.payloads) {
        if (typeof delivery.message === "string") messages.push(delivery.message);
      }
    }
    if (messages.length === 2) return messages;
  }
  return messages;
}
