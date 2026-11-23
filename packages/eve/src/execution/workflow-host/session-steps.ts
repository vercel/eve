import { SHARED_SESSION_STEPS } from "#execution/session/shared-steps.js";
import { dispatchSessionSteps, type SessionStepTable } from "#execution/session/steps.js";
import { applyRunMessagesStep } from "#execution/tools/workflow/apply-run-messages-step.js";
import { dispatchCoordinationStep } from "#execution/workflow-host/dispatch-step.js";
import { turnStep } from "#execution/workflow-host/turn-step.js";

export const WORKFLOW_SESSION_STEPS: SessionStepTable = Object.freeze({
  ...SHARED_SESSION_STEPS,
  turn: turnStep,
  dispatchRuns: dispatchCoordinationStep,
  applyRunMessages: applyRunMessagesStep,
});

export const workflowSessionStep = dispatchSessionSteps(WORKFLOW_SESSION_STEPS);
