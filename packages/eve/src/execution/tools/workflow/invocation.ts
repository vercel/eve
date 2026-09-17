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
  const reader = createChannelReader("body", executeWorkflowToolInvocation(input, signal));
  let onAbort: (() => void) | undefined;
  const cancellation =
    cancelled ??
    new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  cancellation.catch(() => {});
  let started = false;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      started = true;
      const read = await raceChannelReads([reader], cancellation);
      if (read === "cancel" || read.next.done) return;
      if (signal.aborted && read.next.value.kind === "outcome") throw signal.reason;
      if (read.next.value.kind === "outcome" && onAbort !== undefined)
        signal.removeEventListener("abort", onAbort);
      yield read.next.value;
      if (read.next.value.kind === "outcome") return;
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
    // Cleanup can close prompts and release child agents, but cannot undo cancellation.
    const deadline = started
      ? sleep(WORKFLOW_CANCELLATION_CLEANUP_MS).then(() => "cancel" as const)
      : undefined;
    try {
      while (started) {
        const read = await raceChannelReads([reader], deadline);
        if (read === "cancel" || read.next.done || read.next.value.kind === "outcome") break;
        yield read.next.value;
      }
    } catch {}
    yield {
      from: createWorkflowBodyRef(input),
      kind: "outcome",
      result: {
        status: "cancelled",
        reason:
          signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? ""),
      },
    };
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

async function* executeWorkflowToolInvocation(
  input: WorkflowToolInvocationInput,
  signal: AbortSignal,
): AsyncGenerator<WorkflowToolRunMessage> {
  const inbox = openWorkflowToolRunOwnerInbox();
  const bodyReader = createChannelReader(
    "body",
    awaitBodyResult(executeWorkflowBody({ ...input, owner: inbox.owner }, signal)),
  );
  let consumedReports = 0;
  let bodyResult: WorkflowBodyResult | undefined;

  while (true) {
    // Hook persistence does not mean the owner has consumed every report yet.
    if (bodyResult !== undefined && consumedReports >= bodyResult.reportCount) {
      yield {
        from: createWorkflowBodyRef(input),
        kind: "outcome",
        result: bodyResult.outcome,
      };
      return;
    }

    const read = await raceChannelReads(
      bodyResult === undefined ? [inbox.reader, bodyReader] : [inbox.reader],
    );
    if (read.channel === "body") {
      if (read.next.done) throw new Error("Workflow body ended without an outcome.");
      bodyResult = read.next.value;
      continue;
    }
    if (read.next.done) return;
    if (read.next.value.kind === "outcome") continue;
    if (read.next.value.kind === "report") consumedReports += 1;
    yield read.next.value;
  }
}

async function* awaitBodyResult(
  result: Promise<WorkflowBodyResult>,
): AsyncGenerator<WorkflowBodyResult> {
  yield await result;
}
