import { createHook, getWorkflowMetadata, type Hook } from "#compiled/@workflow/core/index.js";
import { createOwnerInbox } from "#execution/inbox/owner.js";
import type { InboxAddress, InboxEnvelope } from "#execution/inbox/types.js";
import { sendInboxStep } from "#execution/inbox/send.js";
import type { AcceptedSubmission } from "#execution/turn/types.js";
import { initializeHolderStep, redirectHolderStep } from "#execution/session/holding-steps.js";
import { startTurnStep } from "#execution/session/dispatch.js";

export interface HoldingWorkflowInput {
  readonly initialToken?: string;
  readonly firstTurn: AcceptedSubmission;
}

export interface RekeyCommand {
  readonly token: string;
  readonly replyTo: InboxAddress;
}

const MAX_SESSION_ALIASES = 128;
const MAX_ALIAS_LENGTH = 2_048;

export async function holdingWorkflow(input: HoldingWorkflowInput): Promise<void> {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  const aliases = new Map<string, Hook<never>>();
  const control = createOwnerInbox({ token: `eve:holder:${workflowRunId}` });
  try {
    const controlClaim = await control.claim();
    if (controlClaim.kind !== "owned")
      throw new Error("Holder control address is already claimed.");
    if (input.initialToken !== undefined) {
      validateAlias(input.initialToken);
      const hook = createHook<never>({ token: input.initialToken });
      const conflict = await hook.getConflict();
      if (conflict !== null) {
        hook.dispose();
        await redirectHolderStep(workflowRunId, conflict.runId, input.firstTurn);
        return;
      }
      aliases.set(input.initialToken, hook);
    }

    const session = await initializeHolderStep(workflowRunId, input.firstTurn.eventId);
    await startTurnStep(session, input.firstTurn);

    while (true) {
      const envelope = await control.next();
      if (envelope.kind !== "rekey" || envelope.requestId === undefined) continue;
      const command = readRekeyCommand(envelope.payload);
      if (command === undefined) continue;
      let status: "claimed" | "conflict" | "limit" | "invalid" = "claimed";
      if (!validAlias(command.token)) status = "invalid";
      else if (!aliases.has(command.token)) {
        if (aliases.size >= MAX_SESSION_ALIASES) {
          status = "limit";
        } else {
          const hook = createHook<never>({ token: command.token });
          const conflict = await hook.getConflict();
          if (conflict === null) aliases.set(command.token, hook);
          else {
            hook.dispose();
            status = "conflict";
          }
        }
      }
      await sendInboxStep(command.replyTo, {
        eventId: envelope.eventId,
        kind: "rekey.response",
        requestId: envelope.requestId,
        payload: { token: command.token, status },
      } satisfies InboxEnvelope);
    }
  } finally {
    for (const hook of aliases.values()) hook.dispose();
    await control.dispose();
  }
}

function validateAlias(token: string): void {
  if (!validAlias(token)) {
    throw new Error("Session alias must be a nonempty bounded string.");
  }
}

function validAlias(token: unknown): token is string {
  return typeof token === "string" && token.length > 0 && token.length <= MAX_ALIAS_LENGTH;
}

function readRekeyCommand(value: unknown): RekeyCommand | undefined {
  if (typeof value !== "object" || value === null || !("token" in value) || !("replyTo" in value))
    return undefined;
  const reply = value.replyTo;
  if (
    typeof reply !== "object" ||
    reply === null ||
    !("token" in reply) ||
    !("ownerRunId" in reply)
  )
    return undefined;
  if (!validAlias(reply.token) || !validAlias(reply.ownerRunId)) return undefined;
  return {
    token: typeof value.token === "string" ? value.token : "",
    replyTo: { token: reply.token, ownerRunId: reply.ownerRunId },
  };
}
