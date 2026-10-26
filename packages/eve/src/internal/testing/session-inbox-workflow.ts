import { createHook, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import { createSessionInbox, type SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";

export async function sessionCommandInboxWorkflow(input: {
  /** Session whose stable inbox this owner holds; a handoff successor names its anchor. */
  readonly sessionId?: string;
  readonly token: string;
}): Promise<void> {
  "use workflow";

  const sessionId = input.sessionId ?? getWorkflowMetadata().workflowRunId;
  const inbox = createSessionInbox(sessionId);

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

/** Parks like a session anchor after a handoff: it holds no session address of its own. */
export async function parkedAnchorWorkflow(input: { readonly token: string }): Promise<void> {
  "use workflow";

  using gate = createHook<void>({ token: input.token });
  await gate;
}

/**
 * Holds `token` until another run force-claims it, reads what arrived before
 * the takeover, then takes the token back and returns the next payload.
 */
export async function sessionInboxTakeoverWorkflow(input: { readonly token: string }): Promise<{
  readonly beforeTakeover: readonly SessionInboxPayload[];
  readonly afterReclaim: SessionInboxPayload | undefined;
}> {
  "use workflow";

  const inbox = createSessionInbox(getWorkflowMetadata().workflowRunId);
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

/** Force-claims `token` and returns once another run takes it back. */
export async function sessionInboxForceClaimWorkflow(input: {
  readonly token: string;
}): Promise<void> {
  "use workflow";

  const inbox = createSessionInbox(getWorkflowMetadata().workflowRunId);
  try {
    await inbox.claimSessionHook(input.token, { force: true });
    await inbox.whenTakenOver();
  } finally {
    await inbox.dispose();
  }
}

/**
 * A session owner from before handoff version 3: on `release` it releases its
 * addresses, then waits for its successor's activation signal.
 */
export async function releasingSessionOwnerWorkflow(input: {
  readonly aliases: readonly string[];
  readonly release: string;
}): Promise<{ readonly activation: unknown; readonly released: readonly SessionInboxPayload[] }> {
  "use workflow";

  const sessionId = getWorkflowMetadata().workflowRunId;
  const inbox = createSessionInbox(sessionId);
  using release = createHook<void>({ token: input.release });
  using activation = createHook<unknown>({ token: `${sessionId}:handoff` });
  try {
    await inbox.claimSessionHooks([sessionCommandHookToken(sessionId), ...input.aliases]);
    await release;
    const released = await inbox.release();
    return { activation: await activation, released };
  } finally {
    await inbox.dispose();
  }
}
