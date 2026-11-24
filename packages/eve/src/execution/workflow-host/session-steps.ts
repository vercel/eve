import { SHARED_SESSION_STEPS } from "#execution/session/shared-steps.js";
import {
  dispatchSessionSteps,
  type SessionStepTable,
  type StepRun,
} from "#execution/session/steps.js";
import { applyRunMessagesStep } from "#execution/tools/workflow/apply-run-messages-step.js";
import { dispatchCoordinationStep } from "#execution/workflow-host/dispatch-step.js";
import { turnStep } from "#execution/workflow-host/turn-step.js";

export const WORKFLOW_SESSION_STEPS: SessionStepTable = Object.freeze({
  ...SHARED_SESSION_STEPS,
  turn: (input, run) =>
    turnStep({
      ...input,
      abortSignal: run?.signals?.cancel,
      steeringSignal: run?.signals?.steer,
      sessionWritable: streamOf(run),
    }),
  dispatchRuns: dispatchCoordinationStep,
  applyRunMessages: applyRunMessagesStep,
});

export const workflowSessionStep = dispatchSessionSteps(WORKFLOW_SESSION_STEPS);

function streamOf(run: StepRun | undefined): WritableStream<Uint8Array> {
  if (run?.stream === undefined) throw new Error("A turn step needs the stream of its run.");
  return run.stream;
}
