import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import { buildResponseAuthorizationTools } from "#context/build-dynamic-tools.js";
import { AuthKey, SessionKey } from "#context/keys.js";
import { clearPendingAuthorization } from "#harness/authorization.js";
import type { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import { createFrameworkUserMessage, validateHarnessModelMessages } from "#harness/messages.js";
import { fail } from "#harness/session-machine/transitions.js";
import type { StepCoordinates } from "#harness/session-machine/view.js";
import type { Step } from "#harness/step/context.js";
import type { HarnessSessionBase, HarnessToolMap, StepResult } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { InputRequest } from "#shared/input.js";
import { renderPendingApprovalsSnippet, renderPendingApprovalsInstruction } from "./approval.js";
import { grantedApprovalKeys } from "./approval.js";
import { hasRunnableQueue } from "./intake.js";
import { checkSessionUsageLimit } from "./budget.js";
import { applyHumanInputDecision } from "./effects.js";
import { approvalsRequested } from "./approval.js";
import { beforeStep, afterStep } from "./decisions.js";
import { holdForInput } from "./intake.js";

// The session's human-in-the-loop lifecycle, behind the few points where the rest of the harness
// meets it: a delivery's answers and sign-in callbacks before its turn runs (`acceptHumanInput`),
// the work they approved once its model step starts (`runApprovedLocalCalls`), a model step's gated calls and
// sign-ins, the budget gate before each model call, and what the model reads about pending
// approvals. Nothing outside this directory reads its records.

export {
  acceptHumanInput,
  admitApprovedWork,
  dispatchApprovedWorkflows,
  hasApprovedWork,
  runApprovedLocalCalls,
  type ApprovedWork,
  type HumanInputIntake,
} from "./intake.js";
export { extractToolApprovalInputRequests } from "#harness/input-extraction.js";
export { hasRunnableQueue } from "./intake.js";

/**
 * A model step made calls that need a person's approval: the step parks on them beside any
 * runtime calls it made. The turn holds for the answers, unless the runtime runs calls for it
 * meanwhile, or queued input can already run.
 */
export async function parkOnApprovals(
  step: Step,
  input: {
    readonly event: StepCoordinates;
    readonly messages: readonly ModelMessage[];
    readonly requests: readonly InputRequest[];
    readonly tasks: readonly RuntimeWorkflowTaskRequest[];
    /** The step made calls the runtime runs, so the turn waits on them instead. */
    readonly waitsOnRuntime: boolean;
    readonly authorizationInterrupt?: NonNullable<
      ReturnType<typeof resolveInlineAuthorizationInterrupt>
    >;
  },
): Promise<StepResult> {
  const pendingStart = input.messages.findIndex((message) => message.role !== "tool");
  const committed = pendingStart === -1 ? input.messages : input.messages.slice(0, pendingStart);
  const messages = input.messages.slice(committed.length);
  const snippet = renderPendingApprovalsSnippet(input.requests);
  const prefix = [
    ...committed,
    ...(snippet === undefined ? [] : [createFrameworkUserMessage("context.state", snippet)]),
  ];
  const decision = afterStep(step.view(), {
    at: input.event,
    inputs: [
      approvalsRequested({
        at: input.event,
        messages,
        requests: input.requests,
        requester: currentRequester(step),
        tools: responseTools(step),
      }),
      ...(input.authorizationInterrupt === undefined
        ? []
        : [
            {
              type: "authorization.required" as const,
              at: input.event,
              callIds: [...input.authorizationInterrupt.callIdsByName.values()].flat(),
              challenges: input.authorizationInterrupt.challenges,
              messages: [],
              requester: currentRequester(step),
            },
          ]),
      ...(input.waitsOnRuntime
        ? [
            {
              type: "actions.dispatched" as const,
              at: input.event,
              messages,
              tasks: input.tasks,
            },
          ]
        : []),
    ],
  });
  await applyHumanInputDecision(step, decision, undefined, {
    commit: prefix,
    messages: [...step.session.history, ...prefix],
  });
  if (input.waitsOnRuntime) return { next: null, session: step.session };
  if (hasRunnableQueue(step.view())) return { next: step.runStep, session: step.session };
  return holdForInput(step);
}

/**
 * A call the model step ran needs a sign-in: the calls that need it stop, and the model calls
 * them again once it completes.
 */
export async function stopForToolSignIn(
  step: Step,
  interrupt: NonNullable<ReturnType<typeof resolveInlineAuthorizationInterrupt>>,
): Promise<StepResult> {
  step.session = { ...step.session, history: validateHarnessModelMessages(interrupt.history) };
  await applyHumanInputDecision(
    step,
    afterStep(step.view(), {
      type: "authorization.required",
      at: step.position(),
      callIds: [...interrupt.callIdsByName.values()].flat(),
      challenges: interrupt.challenges,
      messages: [],
      requester: currentRequester(step),
    }),
    undefined,
    { messages: step.session.history },
  );
  await applyHumanInputDecision(step, beforeStep(step.view(), [{ type: "turn.waiting" }]));
  return { held: { kind: "request" }, next: null, session: step.session };
}

/**
 * The gate before each model call. A spent budget asks whether to continue when someone can
 * answer, and fails the session otherwise. `messages` are the step's: they park with the prompt,
 * so the input that triggered it survives into the turn that resumes.
 */
export async function enforceBudget(
  step: Step,
  messages: readonly ModelMessage[],
): Promise<StepResult | undefined> {
  const limit = checkSessionUsageLimit({
    canAsk: step.emit !== undefined && step.config.capabilities?.requestInput === true,
    session: step.session,
    turnSequence: step.position().sequence,
  });
  if (limit.kind === "within") return undefined;
  if (limit.kind === "ask") {
    step.session = { ...step.session, history: validateHarnessModelMessages([...messages]) };
    await applyHumanInputDecision(
      step,
      beforeStep(step.view(), [
        { type: "budget.exceeded", at: step.position(), request: limit.request },
        { type: "turn.waiting" },
      ]),
    );
    return { held: { kind: "request" }, next: step.runStep, session: step.session };
  }
  await step.apply(
    fail(step.view(), {
      code: limit.code,
      details: limit.details,
      message: limit.message,
      terminal: { sessionId: step.session.sessionId },
    }),
  );
  return { next: { done: true, output: "" }, session: step.session };
}

/**
 * What a model call needs from the approvals: the keys `once()` approvals granted, and a note on
 * the calls still awaiting approval, which a message may revise.
 */
export function humanInputContext(step: Step): {
  readonly approvedTools: ReadonlySet<string>;
  readonly pendingApprovalsNote?: string;
} {
  const view = step.view();
  const tools = responseTools(step);
  return {
    approvedTools: grantedApprovalKeys(view, (request) =>
      tools.get(request.action.toolName)?.approvalKey?.(request.action.input),
    ),
    pendingApprovalsNote: renderPendingApprovalsInstruction(
      view.turn.suspended.flatMap((parked) => parked.requests),
    ),
  };
}

/**
 * Drops what a cleared context owned: sign-in attempts and responders' approval progress. `clear`
 * reported each close; relay routes for live tasks stay.
 */
export function discardClearedHumanInput<T extends HarnessSessionBase>(session: T): T {
  const state = clearPendingAuthorization(session.state) ?? {};
  return { ...session, state: Object.keys(state).length > 0 ? state : undefined };
}

function responseTools(step: Step): HarnessToolMap {
  return buildResponseAuthorizationTools({ authoredTools: step.config.tools, context: step.ctx });
}

/** The caller whose turn parks a step. */
function currentRequester(step: Step): SessionAuthContext | null {
  return step.ctx?.get(AuthKey) ?? step.ctx?.get(SessionKey)?.auth.current ?? null;
}

export { beforeStep, afterStep } from "./decisions.js";

export { applyHumanInputDecision } from "./effects.js";

export type { EffectCommand } from "./command.js";
export { dispatchHumanInputEffects, effectHandlers } from "./effects.js";
export type { BeforeStepArrival } from "./decisions.js";

export {
  isPendingApprovalsSnippet,
  renderPendingApprovalsSnippet,
  renderPendingApprovalsInstruction,
} from "./approval.js";

export type {
  ActiveCandidate,
  ApprovalAudit,
  CandidateDecision,
  FinishedCandidate,
  RelayRoute,
  ResponderIdentity,
  Settlement,
  WorkflowAskRoute,
  ProxyInputQuestion,
} from "./record.js";
export { cleanupHitl, type HitlRecord } from "./record.js";
export { hasHitlRecord } from "./record.js";
export { hitlStepKey } from "./record.js";
