import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";

import type { SessionCommand } from "#channel/types.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { resumeSessionInbox } from "#execution/wire/session-inbox-resume.js";
import { cancelRun, getHookRecordByToken, getWorld } from "#internal/workflow/runtime.js";
import { walkCauseChain } from "#shared/errors.js";

/** Settles side effects owned by a session candidate that lost its continuation claim. */
export async function settleContinuationConflictStep(input: {
  readonly activityCollectorRunId?: string;
  readonly command?: Extract<SessionCommand, { readonly kind: "send" }>;
  readonly continuationToken: string;
  readonly ownerSessionId?: string;
}): Promise<void> {
  "use step";

  try {
    if (input.command !== undefined) {
      await forwardCommand({
        command: input.command,
        continuationToken: input.continuationToken,
        ownerSessionId: input.ownerSessionId,
      });
    }
  } finally {
    if (input.activityCollectorRunId !== undefined) {
      await cancelCollector(input.activityCollectorRunId);
    }
  }
}

async function forwardCommand(input: {
  readonly command: Extract<SessionCommand, { readonly kind: "send" }>;
  readonly continuationToken: string;
  readonly ownerSessionId?: string;
}): Promise<void> {
  try {
    await resumeSessionInbox(input.continuationToken, input.command);
  } catch (error) {
    if (!HookNotFoundError.is(error)) throw error;
    const ownerSessionId = await resolveOwnerSessionId(input);
    await resumeSessionInbox(sessionCommandHookToken(ownerSessionId), input.command);
  }
}

async function resolveOwnerSessionId(input: {
  readonly command: Extract<SessionCommand, { readonly kind: "send" }>;
  readonly continuationToken: string;
  readonly ownerSessionId?: string;
}): Promise<string> {
  if (input.ownerSessionId !== undefined) return input.ownerSessionId;

  try {
    const hook = await getHookRecordByToken(input.continuationToken);
    if (typeof hook.runId === "string" && hook.runId.length > 0) return hook.runId;
  } catch (error) {
    if (!HookNotFoundError.is(error)) throw error;
  }

  const delivery =
    input.command.requestId === undefined ? "" : ` ${JSON.stringify(input.command.requestId)}`;
  throw new Error(
    `Unable to forward losing candidate delivery${delivery}: continuation owner could not be resolved.`,
  );
}

async function cancelCollector(runId: string): Promise<void> {
  try {
    await cancelRun(await getWorld(), runId, {
      cancelReason: "Session candidate did not acquire continuation ownership",
    });
  } catch (error) {
    if (!isInactiveRun(error)) throw error;
  }
}

function isInactiveRun(error: unknown): boolean {
  for (const candidate of walkCauseChain(error)) {
    if (
      WorkflowRunNotFoundError.is(candidate) ||
      RunExpiredError.is(candidate) ||
      EntityConflictError.is(candidate)
    ) {
      return true;
    }
  }
  return false;
}
