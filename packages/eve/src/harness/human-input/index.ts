import type { ModelMessage, TypedToolResult, ToolSet } from "ai";

import { buildResponseAuthorizationTools } from "#context/build-dynamic-tools.js";
import { authorizationEventFields } from "#harness/authorization-event-fields.js";
import {
  getSupersededAuthorizationChallenges,
  setPendingAuthorization,
} from "#harness/authorization.js";
import { setPendingCoordinationBatch } from "#harness/coordination.js";
import { advanceStep, type HarnessEmissionState } from "#harness/emission.js";
import { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import {
  appendPendingInputBatch,
  getApprovedTools,
  hasRunnableDeferredStepInput,
} from "#harness/input-requests.js";
import {
  createFrameworkUserMessage,
  type HarnessModelMessage,
  validateHarnessModelMessages,
} from "#harness/messages.js";
import { getPendingInputBatches } from "#harness/pending-input-batches.js";
import type { Step } from "#harness/step/context.js";
import type { HarnessToolMap, StepResult } from "#harness/types.js";
import { dispatchApprovedWorkflowCalls } from "#harness/workflow-dispatch.js";
import {
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
  createInputRequestedEvent,
} from "#protocol/message.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { InputRequest } from "#shared/input.js";
import {
  renderPendingApprovalsInstruction,
  renderPendingApprovalsSnippet,
} from "./approval-prompt.js";
import { applyBudgetAnswer } from "./budget.js";
import { type ApprovedWork, approvalKeyResolver, holdForInput } from "./intake.js";

// The session's human-in-the-loop lifecycle, behind the few points where the rest of the harness
// meets it: a delivery's answers before its turn runs (`acceptHumanInput`), the work they approved
// once it does (`runApprovedWork`, `dispatchApprovedWorkflows`), what a model call reads about the
// approvals (`humanInputContext`), the budget gate before each model call, and a model step's
// gated calls and sign-ins. Nothing outside this directory reads its modules.

export { acceptHumanInput, type ApprovedWork, type HumanInputIntake } from "./intake.js";
export { enforceBudget } from "./budget.js";
export { declinedSignInEvents, withdrawHeldSignIns } from "./held-requests.js";
export { extractToolApprovalInputRequests } from "#harness/input-extraction.js";
export {
  cancelApprovalInputBatches,
  getPendingApprovalRequests,
} from "#harness/hitl/approval-input-requests.js";
export {
  clearPendingSessionLimitPrompt,
  hasRunnableDeferredStepInput,
} from "#harness/input-requests.js";

/** Work the answers approved that runs once their turn opens: a granted budget. */
export function runApprovedWork(step: Step, approved: ApprovedWork): void {
  applyBudgetAnswer(step, approved.limit);
}

/**
 * Approved workflow calls start like ungated ones, once the model step started, and the turn
 * waits on the runtime for their runs.
 */
export function dispatchApprovedWorkflows(
  step: Step,
  approved: ApprovedWork,
  messages: readonly HarnessModelMessage[],
): StepResult | undefined {
  const dispatched = dispatchApprovedWorkflowCalls({
    messages: [...messages],
    resolvedInputs: approved.resolved,
    session: step.session,
    tools: responseTools(step),
  });
  if (dispatched === undefined) return undefined;
  step.session = dispatched;
  step.moveTo(advanceStep(step.position()));
  return { next: null, session: step.session };
}

/**
 * What a model call needs from the approvals: the keys `once()` approvals granted, and a note on
 * the calls still awaiting approval. An approved call replays through the AI SDK, so its tool
 * must still exist.
 */
export function humanInputContext(
  step: Step,
  approved: ApprovedWork,
): { readonly approvedTools: ReadonlySet<string>; readonly pendingApprovalsNote?: string } {
  const tools = responseTools(step);
  for (const batch of approved.resolved) {
    for (const { outcome, request } of batch.inputs) {
      if (outcome === "approved" && !tools.has(request.action.toolName)) {
        throw new Error(
          "The approved tool is no longer available. Request a new tool call and approval.",
        );
      }
    }
  }
  return {
    approvedTools: getApprovedTools(step.session, approvalKeyResolver(tools)),
    pendingApprovalsNote: renderPendingApprovalsInstruction(
      getPendingInputBatches(step.session.state).flatMap((batch) => batch.requests),
    ),
  };
}

/**
 * A model step made calls that need a person's approval. The step's committed tool results join
 * history with a note on the pending approvals, and the rest of its response parks with them. With
 * `runtimeCalls`, the step parks on those runs too and the turn waits on the runtime; otherwise
 * the turn holds for the answers, unless queued input can already run.
 */
export async function parkOnApprovals(
  step: Step,
  input: {
    readonly position: HarnessEmissionState;
    readonly promptMessages: readonly HarnessModelMessage[];
    readonly responseMessages: readonly ModelMessage[];
    readonly requests: readonly InputRequest[];
    readonly runtimeCalls?: readonly RuntimeWorkflowTaskRequest[];
  },
): Promise<StepResult> {
  const { position, requests, responseMessages } = input;
  const note = renderPendingApprovalsSnippet(requests);
  // Results of resumed work stay ahead of the note; only the unresolved response parks.
  const pendingStart = responseMessages.findIndex((message) => message.role !== "tool");
  const committed =
    pendingStart === -1 ? responseMessages : responseMessages.slice(0, pendingStart);
  const pendingResponse = responseMessages.slice(committed.length);
  const history = validateHarnessModelMessages([
    ...input.promptMessages,
    ...committed,
    ...(note === undefined ? [] : [createFrameworkUserMessage("context.state", note)]),
  ]);
  const event = {
    sequence: position.sequence,
    stepIndex: position.stepIndex,
    turnId: position.turnId,
  };
  const batch = {
    event,
    requests,
    responseAuthRequiredRequestIds: responsePolicyRequestIds(step, requests),
  };

  if (input.runtimeCalls !== undefined) {
    // The runtime's batch owns the shared assistant response.
    step.session = appendPendingInputBatch({
      ...batch,
      responseMessages: [],
      session: setPendingCoordinationBatch({
        event,
        responseMessages: pendingResponse,
        session: { ...step.session, history },
        tasks: input.runtimeCalls,
      }),
    });
    await step.emit?.(createInputRequestedEvent({ requests: [...requests], ...event }));
    step.moveTo(advanceStep(position));
    return { next: null, session: step.session };
  }

  step.session = appendPendingInputBatch({
    ...batch,
    responseMessages: pendingResponse,
    session: { ...step.session, history },
  });
  const runsQueuedInput = hasRunnableDeferredStepInput(step.session);
  await step.emit?.(createInputRequestedEvent({ requests: [...requests], ...event }));
  if (runsQueuedInput) return { next: step.runStep, session: step.session };
  await holdForInput(step, position);
  return { held: { kind: "request" }, next: null, session: step.session };
}

/**
 * A call the model step ran needs a sign-in: the turn holds until it completes, and supersedes the
 * attempts it replaces.
 */
export async function stopForToolSignIn(
  step: Step,
  input: {
    readonly messages: readonly ModelMessage[];
    readonly position: HarnessEmissionState;
    readonly toolResults: readonly TypedToolResult<ToolSet>[] | undefined;
  },
): Promise<StepResult | undefined> {
  const interrupt = resolveInlineAuthorizationInterrupt({
    messages: [...input.messages],
    toolResults: input.toolResults,
  });
  if (!interrupt) return undefined;
  const { challenges } = interrupt;
  const { sequence, stepIndex, turnId } = input.position;
  if (step.emit !== undefined) {
    for (const superseded of getSupersededAuthorizationChallenges(step.session.state, challenges)) {
      await step.emit(
        createAuthorizationCompletedEvent({
          ...authorizationEventFields(superseded),
          outcome: "failed",
          reason: "Superseded by a newer authorization attempt.",
          sequence,
          stepIndex,
          turnId,
        }),
      );
    }
    for (const challenge of challenges) {
      await step.emit(
        createAuthorizationRequiredEvent({
          ...authorizationEventFields(challenge),
          description:
            challenge.challenge.instructions ?? `Authorization required for ${challenge.name}`,
          sequence,
          stepIndex,
          turnId,
          webhookUrl: challenge.hookUrl,
        }),
      );
    }
  }
  step.session = {
    ...step.session,
    history: validateHarnessModelMessages(interrupt.history),
    state: setPendingAuthorization(step.session.state, { challenges }),
  };
  await holdForInput(step, input.position);
  return { held: { kind: "request" }, next: null, session: step.session };
}

function responseTools(step: Step): HarnessToolMap {
  return buildResponseAuthorizationTools({ authoredTools: step.config.tools, context: step.ctx });
}

/**
 * The approvals whose tool defines a response policy. Every park records them, so no Approve or
 * Cancel of such an approval skips the policy.
 */
function responsePolicyRequestIds(
  step: Step,
  requests: readonly InputRequest[],
): readonly string[] {
  const tools = responseTools(step);
  return requests
    .filter((request) => {
      const approval = tools.get(request.action.toolName)?.approval;
      return (
        approval !== undefined && typeof approval !== "function" && approval.response !== undefined
      );
    })
    .map((request) => request.requestId);
}
