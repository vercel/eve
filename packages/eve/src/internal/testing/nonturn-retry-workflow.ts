import {
  getStepMetadata,
  getWorkflowMetadata,
  getWritable,
} from "#compiled/@workflow/core/index.js";
import { commitSessionStep, publishSessionEvents } from "#execution/publish-session-events.js";
import { applySessionStateDelta } from "#execution/session/state-delta.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import { fact } from "#harness/facts.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { emitTerminalSessionCompletionStep } from "#execution/terminal-session-completion-step.js";

async function publishStart(context: Record<string, unknown>, failBeforePublication = false) {
  "use step";
  if (failBeforePublication && getStepMetadata().attempt === 1) {
    throw new Error("Transient failure before publication");
  }
  const sessionId = getWorkflowMetadata().workflowRunId;
  return await publishSessionEvents(
    {
      serializedContext: { ...context, "eve.sessionId": sessionId },
      sessionState: createTestSessionState({ sessionId }),
      sessionWritable: getWritable<Uint8Array>(),
    },
    [fact("session.started", {})],
  );
}

async function publishNext(
  input: Pick<Awaited<ReturnType<typeof publishStart>>, "serializedContext" | "sessionState">,
) {
  "use step";
  await publishSessionEvents({ ...input, sessionWritable: getWritable<Uint8Array>() }, [
    fact("turn.started", { turnId: "turn_0", follows: null, cause: { policy: "test" } }),
  ]);
}

export async function beforePublicationRetryWorkflow(context: Record<string, unknown>) {
  "use workflow";
  await publishStart(context, true);
  return getWorkflowMetadata().workflowRunId;
}

async function commitTwice(context: Record<string, unknown>) {
  "use step";
  const sessionId = getWorkflowMetadata().workflowRunId;
  const initial = {
    serializedContext: { ...context, "eve.sessionId": sessionId },
    sessionState: createTestSessionState({ sessionId }),
    sessionWritable: getWritable<Uint8Array>(),
  };
  const started = await commitSessionStep(
    initial,
    (view) => [{ events: [fact("session.started", {})], turn: view.turn }],
    { origin: "own" },
  );
  await commitSessionStep(
    { ...initial, ...started },
    (view) => [
      {
        events: [
          fact("turn.started", { turnId: "turn_0", follows: null, cause: { policy: "test" } }),
        ],
        turn: view.turn,
      },
    ],
    { origin: "own" },
  );
}

export async function terminalAfterStaleCheckpointWorkflow(
  context: Record<string, unknown>,
  unavailableProviders: boolean | "unreadable" = false,
) {
  "use workflow";
  const started = await publishStart(context);
  await publishNext(started);
  await emitTerminalSessionCompletionStep({
    ...started,
    ...(unavailableProviders && {
      serializedContext: {
        "eve.sessionId": getWorkflowMetadata().workflowRunId,
        ...(unavailableProviders === "unreadable" && { "eve.stateLayout": 0 }),
      },
    }),
    sessionWritable: getWritable<Uint8Array>(),
    usage: undefined,
  });
  return getWorkflowMetadata().workflowRunId;
}

export async function commitTwiceWorkflow(context: Record<string, unknown>) {
  "use workflow";
  await commitTwice(context);
  return getWorkflowMetadata().workflowRunId;
}

async function publishProgress(
  state: Pick<Awaited<ReturnType<typeof publishStart>>, "serializedContext" | "sessionState">,
  count: number,
) {
  "use step";
  return await publishSessionEvents(
    { ...state, sessionWritable: getWritable<Uint8Array>() },
    Array.from({ length: count }, (_, index) => ({
      type: "call.progress" as const,
      data: { callId: "long_call", output: { index } },
    })),
  );
}

async function publishRunning(
  start: Pick<Awaited<ReturnType<typeof publishStart>>, "serializedContext" | "sessionState">,
) {
  "use step";
  return await publishSessionEvents({ ...start, sessionWritable: getWritable<Uint8Array>() }, [
    fact("turn.started", { turnId: "turn_0", follows: null, cause: { policy: "test" } }),
    fact("model.requested", { runId: "model", owner: { turnId: "turn_0" } }),
    fact("call.requested", {
      callId: "long_call",
      owner: { runId: "model" },
      capability: { kind: "tool", name: "long-running" },
    }),
    fact("call.started", { callId: "long_call" }),
  ]);
}

export async function progressWindowRetryWorkflow(context: Record<string, unknown>) {
  "use workflow";
  const sessionId = getWorkflowMetadata().workflowRunId;
  const start = await publishStart(context);
  const running = await publishRunning(start);
  const progressed = await publishProgress(running, 257);
  await publishProgress(progressed, 1);
  return sessionId;
}

export async function nonturnRetryWorkflow(context: Record<string, unknown>): Promise<string> {
  "use workflow";
  const sessionId = getWorkflowMetadata().workflowRunId;
  const started = await publishStart(context);
  await publishNext(started);
  return sessionId;
}

/** The session's values before its first step. */
async function initialValues(context: Record<string, unknown>) {
  "use step";
  const sessionId = getWorkflowMetadata().workflowRunId;
  return {
    history: [],
    serializedContext: { ...context, "eve.sessionId": sessionId },
    sessionState: createTestSessionState({ sessionId }),
  };
}

/** Publishes two commits, then only the first once its retry decides differently. */
async function publishLessOnRetry(
  values: Awaited<ReturnType<typeof initialValues>>,
  replay: "prefix" | "none",
) {
  "use step";
  return await withSessionStateDelta(
    { ...values, sessionWritable: getWritable<Uint8Array>() },
    async (state) => {
      if (getStepMetadata().attempt > 1 && replay === "none") return {};
      const started = await commitSessionStep(
        state,
        (view) => [{ events: [fact("session.started", {})], turn: view.turn }],
        { origin: "own" },
      );
      if (getStepMetadata().attempt > 1) return started;
      await commitSessionStep(
        { ...state, ...started },
        (view) => [
          {
            events: [
              fact("turn.started", { turnId: "turn_0", follows: null, cause: { policy: "test" } }),
            ],
            turn: view.turn,
          },
        ],
        { origin: "own" },
      );
      throw new Error("Interrupted after publishing");
    },
  );
}

async function settleTurn(
  input: Pick<Awaited<ReturnType<typeof publishStart>>, "serializedContext" | "sessionState">,
) {
  "use step";
  await publishSessionEvents({ ...input, sessionWritable: getWritable<Uint8Array>() }, [
    fact("turn.settled", { turnId: "turn_0", outcome: "completed" }),
  ]);
}

export async function lessOnRetryWorkflow(
  context: Record<string, unknown>,
  replay: "prefix" | "none",
) {
  "use workflow";
  const values = await initialValues(context);
  const { stateDelta } = await publishLessOnRetry(values, replay);
  await settleTurn(applySessionStateDelta(values, stateDelta));
  return getWorkflowMetadata().workflowRunId;
}
