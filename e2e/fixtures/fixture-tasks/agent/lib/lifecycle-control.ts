import { createHook, getWorkflowMetadata } from "workflow";
import { getRun } from "workflow/api";

export interface LifecycleControlEvent {
  readonly kind: "gate" | "owner" | "gate-cancelled";
  readonly marker: "A" | "B" | "parent";
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly token?: string;
}

export const lifecycleNamespace = (key: string) => `fixture-tasks.lifecycle.${key}`;

export async function publishLifecycleControl(
  parentSessionId: string,
  key: string,
  event: LifecycleControlEvent,
) {
  "use step";
  const ops: Promise<void>[] = [];
  const writer = getRun(parentSessionId)
    .getWritable<LifecycleControlEvent>({ namespace: lifecycleNamespace(key), ops })
    .getWriter();
  try {
    await writer.write(event);
  } finally {
    writer.releaseLock();
  }
  await Promise.all(ops);
}

export async function lifecycleGate(
  input: {
    parentSessionId: string;
    key: string;
    marker: "A" | "B" | "parent";
    sessionId: string;
    turnId: string;
  },
  signal?: AbortSignal,
) {
  const gate = createHook<void>({
    metadata: { parentSessionId: input.parentSessionId, key: input.key },
  });
  await publishLifecycleControl(input.parentSessionId, input.key, {
    kind: "gate",
    marker: input.marker,
    token: gate.token,
    runId: getWorkflowMetadata().workflowRunId,
    sessionId: input.sessionId,
    turnId: input.turnId,
  });
  if (signal === undefined) {
    await gate;
    return;
  }

  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = () => rejectAbort?.(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await Promise.race([gate, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
    // Do not await the unresolved hook iterator during cancellation teardown.
    await gate.dispose();
    if (signal.aborted) {
      await publishLifecycleControl(input.parentSessionId, input.key, {
        kind: "gate-cancelled",
        marker: input.marker,
        runId: getWorkflowMetadata().workflowRunId,
        sessionId: input.sessionId,
        turnId: input.turnId,
      });
    }
  }
}
