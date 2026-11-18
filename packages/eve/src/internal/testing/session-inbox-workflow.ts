import { workflowInboxTransport } from "#execution/session-inbox/workflow-transport.js";
import { createHook, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import { createSessionInbox, type SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";

export async function sessionCommandInboxWorkflow(input: {
  readonly sessionId?: string;
  readonly token: string;
}): Promise<void> {
  "use workflow";

  const sessionId = input.sessionId ?? getWorkflowMetadata().workflowRunId;
  const inbox = createSessionInbox(workflowInboxTransport(sessionId));

  try {
    await inbox.claimSessionHook(sessionCommandHookToken(sessionId));
    await inbox.claimSessionHook(input.token);
    while (true) {
      const payload = await inbox.next();
      if (payload === undefined || payload.kind === "reset") return;
    }
  } finally {
    await inbox.dispose();
  }
}

export async function parkedAnchorWorkflow(input: { readonly token: string }): Promise<void> {
  "use workflow";

  using gate = createHook<void>({ token: input.token });
  await gate;
}

export async function parkedTaskRunWorkflow(input: { readonly token: string }): Promise<unknown> {
  "use workflow";

  using control = createHook<unknown>({ token: input.token });
  return await control;
}

export async function sessionInboxTakeoverWorkflow(input: { readonly token: string }): Promise<{
  readonly beforeTakeover: readonly SessionInboxPayload[];
  readonly afterReclaim: SessionInboxPayload | undefined;
}> {
  "use workflow";

  const inbox = createSessionInbox(workflowInboxTransport(getWorkflowMetadata().workflowRunId));
  try {
    await inbox.claimSessionHook(input.token);
    await inbox.whenTakenOver();
    const beforeTakeover: SessionInboxPayload[] = [];
    for (let payload = await inbox.next(); payload !== undefined; payload = await inbox.next())
      beforeTakeover.push(payload);
    await inbox.claimSessionHook(input.token, { force: true });
    return { afterReclaim: await inbox.next(), beforeTakeover };
  } finally {
    await inbox.dispose();
  }
}

export async function sessionInboxForceClaimWorkflow(input: {
  readonly token: string;
}): Promise<void> {
  "use workflow";

  const inbox = createSessionInbox(workflowInboxTransport(getWorkflowMetadata().workflowRunId));
  try {
    await inbox.claimSessionHook(input.token, { force: true });
    await inbox.whenTakenOver();
  } finally {
    await inbox.dispose();
  }
}
