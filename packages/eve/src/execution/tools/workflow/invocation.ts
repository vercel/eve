import { WORKFLOW_CANCELLATION_CLEANUP_MS } from "#execution/tools/workflow/cancellation-policy.js";
import { sleep } from "#compiled/@workflow/core/index.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import {
  createWorkflowBodyRef,
  executeWorkflowBody,
  type WorkflowBodyDefinition,
  type WorkflowBodyResult,
} from "#execution/tools/workflow/body.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import { createChannelReader, raceChannelReads } from "#execution/tools/workflow/owner-channels.js";
import { openWorkflowToolRunOwnerInbox } from "#execution/tools/workflow/owner.js";

export interface WorkflowToolInvocationInput extends WorkflowBodyDefinition {
  readonly execution: "background" | "blocking";
}

/**
 * Starts one workflow body and exposes its requests, reports, and outcome as a
 * single ordered stream. The body starts when its owner reads the stream.
 */
export async function* runWorkflowToolInvocation(
  input: WorkflowToolInvocationInput,
  signal: AbortSignal,
  cancelled?: Promise<never>,
): AsyncGenerator<WorkflowToolRunMessage> {
  let onAbort: (() => void) | undefined;
  const cancellation =
    cancelled ??
    new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  cancellation.catch(() => {});
  try {
    if (signal.aborted) throw signal.reason;
    const inbox = openWorkflowToolRunOwnerInbox();
    const bodyReader = createChannelReader(
      "body",
      awaitBodyResult(executeWorkflowBody({ ...input, owner: inbox.owner }, signal)),
    );
    let consumedReports = 0;
    let bodyResult: WorkflowBodyResult | undefined;
    let cleanupDeadline: Promise<"cancel"> | undefined;

    while (true) {
      if (signal.aborted && cleanupDeadline === undefined) {
        cleanupDeadline = sleep(WORKFLOW_CANCELLATION_CLEANUP_MS).then(() => "cancel");
      }
      // Hook persistence does not mean the owner has consumed every report yet.
      if (bodyResult !== undefined && consumedReports >= bodyResult.reportCount) {
        if (signal.aborted) break;
        if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
        yield { from: createWorkflowBodyRef(input), kind: "outcome", result: bodyResult.outcome };
        return;
      }

      let read;
      try {
        read = await raceChannelReads(
          bodyResult === undefined ? [inbox.reader, bodyReader] : [inbox.reader],
          cleanupDeadline ?? cancellation,
        );
      } catch (error) {
        // Keep the same pending reads while switching from execution to bounded cleanup.
        if (signal.aborted && cleanupDeadline === undefined) continue;
        throw error;
      }
      if (read === "cancel") break;
      if (read.channel === "body") {
        if (read.next.done) throw new Error("Workflow body ended without an outcome.");
        bodyResult = read.next.value;
        continue;
      }
      if (read.next.done) {
        if (signal.aborted) break;
        return;
      }
      if (read.next.value.kind === "outcome") continue;
      if (read.next.value.kind === "report") consumedReports += 1;
      yield read.next.value;
    }
  } catch (error) {
    if (!signal.aborted) {
      yield {
        from: createWorkflowBodyRef(input),
        kind: "outcome",
        result: { status: "failed", error: normalizeSerializableError(error) },
      };
      return;
    }
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
  // Cleanup cannot undo cancellation, even when the body returns success.
  yield {
    from: createWorkflowBodyRef(input),
    kind: "outcome",
    result: {
      status: "cancelled",
      reason: signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? ""),
    },
  };
}

async function* awaitBodyResult(
  result: Promise<WorkflowBodyResult>,
): AsyncGenerator<WorkflowBodyResult> {
  yield await result;
}
