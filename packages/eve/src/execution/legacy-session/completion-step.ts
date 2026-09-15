import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { WorkflowEntryResult } from "#execution/workflow-entry-input.js";

/** The old driver owns final notifications for the dispatch that became this session. */
export async function completeLegacyDriverStep(input: {
  readonly completionToken: string;
  readonly result: WorkflowEntryResult;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly sessionWritable: WritableStream<Uint8Array>;
}): Promise<void> {
  "use step";
  const writer = input.sessionWritable.getWriter();
  try {
    await writer.close();
  } finally {
    writer.releaseLock();
  }
  try {
    await resumeHook(input.completionToken, {
      kind: "turn-result",
      action: {
        kind: "done",
        ...input.result,
        serializedContext: input.serializedContext,
        sessionState: {
          ...input.sessionState,
          snapshot: { version: 1, session: input.sessionState.snapshot.session },
        },
      },
    });
  } catch (error) {
    if (!HookNotFoundError.is(error)) throw error;
  }
}
