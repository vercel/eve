import {
  createWorkflowBodyRef,
  executeWorkflowBody,
  type WorkflowBodyDefinition,
  type WorkflowBodyResult,
} from "#execution/tools/workflow/body.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import {
  createChannelReader,
  raceChannelReads,
  type ChannelReader,
} from "#execution/tools/workflow/owner-channels.js";
import { openWorkflowToolRunOwnerInbox } from "#execution/tools/workflow/owner.js";

export interface WorkflowToolInvocationInput extends WorkflowBodyDefinition {
  readonly execution: "background" | "blocking";
}

/**
 * Starts one workflow body and exposes its requests, reports, and outcome as a
 * single ordered stream. Creating the reader is inert until its owner reads it.
 */
export function createWorkflowToolInvocationReader(
  input: WorkflowToolInvocationInput,
  signal: AbortSignal,
): ChannelReader<"workflow", WorkflowToolRunMessage> {
  return createChannelReader("workflow", executeWorkflowToolInvocation(input, signal));
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
