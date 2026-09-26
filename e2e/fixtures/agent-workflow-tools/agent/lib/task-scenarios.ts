import {
  latestTaskResult,
  outputOf,
  playScript,
  taskIdFromReceipt,
} from "@eve-e2e/config/mock-script";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

import { DELEGATE_INTERIM_MESSAGE, STAGE_INTERIM_MESSAGE } from "../../task-scenario-text.ts";
import { HOLD_REQUEST } from "./plan-revisions.ts";

type Scenario = (request: MockModelRequest) => MockModelResponse | string;

/**
 * Task and steering scenarios for the root agent, keyed by the directive that
 * starts them. Each one is a fixed sequence of calls with stable ids, so evals
 * can assert on those ids.
 */
const SCENARIOS: Readonly<Record<string, Scenario>> = {
  "WORKFLOW-STAGE-WAIT": (request) =>
    playScript(
      request,
      [
        { id: "stage", input: apiService, name: "stage_deploy" },
        { id: "stage-wait", name: "task_wait" },
      ],
      () => report("WORKFLOW-STAGE-RESULT", latestTaskResult(request, "stage_deploy")),
    ),

  "WORKFLOW-STAGE-HOLD": (request) =>
    playScript(request, [{ id: "stage", input: apiService, name: "stage_deploy" }], () =>
      reportOnceSettled(request, "stage_deploy", "WORKFLOW-STAGE-RESULT", STAGE_INTERIM_MESSAGE),
    ),

  "WORKFLOW-CANARY-CANCEL": (request) =>
    playScript(
      request,
      [
        { id: "canary", input: apiService, name: "canary_deploy" },
        { id: "canary-cancel", input: taskOf("canary"), name: "task_cancel" },
      ],
      () => report("WORKFLOW-CANARY-RESULT", outputOf(request, "canary-cancel")),
    ),

  "WORKFLOW-PLAN-START": (request) =>
    playScript(
      request,
      [
        { id: "plan-draft", input: () => ({ request: "draft" }), name: "revise_plan" },
        { id: "plan-draft-wait", name: "task_wait" },
      ],
      () => report("WORKFLOW-PLAN-RESULT", latestTaskResult(request, "revise_plan")),
    ),

  // Holds the plan task busy, cancels that work, then revises the same task again.
  "WORKFLOW-PLAN-REVISE": (request) =>
    playScript(
      request,
      [
        { id: "plan-hold", input: revisionOf(HOLD_REQUEST), name: "revise_plan" },
        { id: "plan-hold-wait", input: () => ({ timeout: 1_000 }), name: "task_wait" },
        { id: "plan-cancel", input: taskOf("plan-draft"), name: "task_cancel" },
        { id: "plan-final", input: revisionOf("final"), name: "revise_plan" },
        { id: "plan-final-wait", name: "task_wait" },
      ],
      () => report("WORKFLOW-PLAN-RESULT", latestTaskResult(request, "revise_plan")),
    ),

  "WORKFLOW-DELEGATE-STAGE": (request) =>
    playScript(
      request,
      [{ id: "delegate", input: () => ({ message: "Stage api." }), name: "workflow-stager" }],
      () =>
        reportOnceSettled(
          request,
          "workflow-stager",
          "WORKFLOW-DELEGATE-RESULT",
          DELEGATE_INTERIM_MESSAGE,
        ),
    ),

  "WORKFLOW-SLEEP-START": (request) =>
    playScript(request, [{ id: "nap", input: () => ({ seconds: 600 }), name: "sleep" }], () =>
      report("WORKFLOW-SLEEP-RESULT", outputOf(request, "nap")),
    ),

  "WORKFLOW-OFFER-START": (request) =>
    playScript(request, [{ id: "offer", input: apiService, name: "offer_deploy" }], () =>
      report("WORKFLOW-OFFER-RESULT", outputOf(request, "offer")),
    ),
};

/** The scripted response for a task or steering scenario, or `undefined` for any other directive. */
export function respondToTaskScenario(
  request: MockModelRequest,
  directive: string,
): MockModelResponse | string | undefined {
  return SCENARIOS[directive]?.(request);
}

function apiService(): { service: string } {
  return { service: "api" };
}

/** Input naming the task the receipt of `callId` started. */
function taskOf(callId: string): (request: MockModelRequest) => { taskId: string } {
  return (request) => ({ taskId: taskIdFromReceipt(request, callId) });
}

/** Input that sends the plan task started by `plan-draft` another revision. */
function revisionOf(revision: string) {
  return (request: MockModelRequest) => ({
    request: revision,
    taskId: taskIdFromReceipt(request, "plan-draft"),
  });
}

/**
 * Ends the model's step with text while the task still works, which holds the
 * turn; once the result arrives, reports it.
 */
function reportOnceSettled(
  request: MockModelRequest,
  tool: string,
  label: string,
  interim: string,
): string {
  const result = latestTaskResult(request, tool);
  return result === undefined ? interim : report(label, result);
}

function report(label: string, output: string | undefined): string {
  if (output === undefined) throw new Error(`${label}: the script expected a task result.`);
  return `${label} ${output}`;
}
