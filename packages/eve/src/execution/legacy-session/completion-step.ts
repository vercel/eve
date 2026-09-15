import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { WorkflowEntryResult } from "#execution/workflow-entry-input.js";
import type { PreparedLegacySession } from "./prepare-step.js";

/** The old driver owns final notifications for the dispatch that became this session. */
export async function completeLegacyDriverStep(input: {
  readonly prepared: PreparedLegacySession;
  readonly result: WorkflowEntryResult;
}): Promise<void> {
  "use step";
  const { prepared } = input;
  const writer = prepared.input.parentWritable.getWriter();
  try {
    await writer.close();
  } finally {
    writer.releaseLock();
  }
  try {
    await resumeHook(prepared.input.completionToken, {
      kind: "turn-result",
      action: {
        kind: "done",
        ...input.result,
        serializedContext: prepared.input.serializedContext,
        sessionState: {
          ...prepared.sessionState,
          snapshot: { version: 1, session: prepared.sessionState.snapshot.session },
        },
      },
    });
  } catch (error) {
    if (!HookNotFoundError.is(error)) throw error;
  }
}
