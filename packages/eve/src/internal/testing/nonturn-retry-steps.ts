import { builtInHosts } from "#runtime/app.js";
import {
  commitSessionStep,
  enterSessionStep,
  publishSessionEvents,
} from "#execution/publish-session-events.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import { fact } from "#harness/facts.js";
import { commitOf, transition } from "#harness/session-machine/commit.js";
import { createTestSessionState } from "#internal/testing/session-state.js";

export interface TestStepAttempt {
  readonly sessionId: string;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly attempt: number;
}

type Published = Awaited<ReturnType<typeof publishSessionEvents>>;

export type PublishedState = Pick<Published, "serializedContext" | "sessionState">;

const turnStarted = () =>
  fact("turn.started", { turnId: "turn_0", follows: null, cause: { policy: "test" } });

export async function publishStart(
  step: TestStepAttempt,
  context: Record<string, unknown>,
  failBeforePublication = false,
): Promise<Published> {
  if (failBeforePublication && step.attempt === 1) {
    throw new Error("Transient failure before publication");
  }
  return await publishSessionEvents(
    enterSessionStep(builtInHosts(), {
      serializedContext: { ...context, "eve.sessionId": step.sessionId },
      sessionState: createTestSessionState({ sessionId: step.sessionId }),
      sessionWritable: step.sessionWritable,
    }),
    [commitOf([fact("session.started", {})])],
  );
}

export async function publishNext(step: TestStepAttempt, input: PublishedState): Promise<void> {
  await publishSessionEvents(
    enterSessionStep(builtInHosts(), { ...input, sessionWritable: step.sessionWritable }),
    [commitOf([turnStarted()])],
  );
}

export async function commitTwice(
  step: TestStepAttempt,
  context: Record<string, unknown>,
): Promise<void> {
  const initial = enterSessionStep(builtInHosts(), {
    serializedContext: { ...context, "eve.sessionId": step.sessionId },
    sessionState: createTestSessionState({ sessionId: step.sessionId }),
    sessionWritable: step.sessionWritable,
  });
  const started = await commitSessionStep(
    initial,
    (view) => [transition({ events: [fact("session.started", {})], turn: view.turn })],
    { origin: "own" },
  );
  await commitSessionStep(
    { ...initial, ...started },
    (view) => [transition({ events: [turnStarted()], turn: view.turn })],
    { origin: "own" },
  );
}

export async function publishRunning(
  step: TestStepAttempt,
  start: PublishedState,
): Promise<Published> {
  return await publishSessionEvents(
    enterSessionStep(builtInHosts(), { ...start, sessionWritable: step.sessionWritable }),
    [
      commitOf([
        turnStarted(),
        fact("model.requested", { runId: "model", owner: { turnId: "turn_0" } }),
        fact("call.requested", {
          callId: "long_call",
          owner: { runId: "model" },
          capability: { kind: "tool", name: "long-running" },
        }),
        fact("call.started", { callId: "long_call" }),
      ]),
    ],
  );
}

export async function publishProgress(
  step: TestStepAttempt,
  state: PublishedState,
  count: number,
): Promise<Published> {
  return await publishSessionEvents(
    enterSessionStep(builtInHosts(), { ...state, sessionWritable: step.sessionWritable }),
    Array.from({ length: count }, (_, index) => ({
      type: "call.progress" as const,
      data: { callId: "long_call", output: { index } },
    })),
  );
}

export function initialValues(sessionId: string, context: Record<string, unknown>) {
  return {
    history: [],
    serializedContext: { ...context, "eve.sessionId": sessionId },
    sessionState: createTestSessionState({ sessionId }),
  };
}

export async function publishLessOnRetry(
  step: TestStepAttempt,
  values: ReturnType<typeof initialValues>,
  replay: "prefix" | "none",
) {
  return await withSessionStateDelta(
    builtInHosts(),
    { ...values, sessionWritable: step.sessionWritable },
    async (state) => {
      if (step.attempt > 1 && replay === "none") return {};
      const started = await commitSessionStep(
        state,
        (view) => [transition({ events: [fact("session.started", {})], turn: view.turn })],
        { origin: "own" },
      );
      if (step.attempt > 1) return started;
      await commitSessionStep(
        { ...state, ...started },
        (view) => [transition({ events: [turnStarted()], turn: view.turn })],
        { origin: "own" },
      );
      throw new Error("Interrupted after publishing");
    },
  );
}

export async function settleTurn(step: TestStepAttempt, input: PublishedState): Promise<void> {
  await publishSessionEvents(
    enterSessionStep(builtInHosts(), { ...input, sessionWritable: step.sessionWritable }),
    [commitOf([fact("turn.settled", { turnId: "turn_0", outcome: "completed" })])],
  );
}
