import type { ModelMessage, ToolSet, TypedToolResult } from "ai";

import { buildResponseAuthorizationTools } from "#context/build-dynamic-tools.js";
import { collectDeferredCalls } from "#harness/coordination.js";
import { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import type { ResolvedInputBatch } from "#harness/input-request-resolution.js";
import { stepStartedForResolvers } from "#harness/session-machine/resolver-events.js";
import {
  completeSignIn,
  hold,
  settle,
  type SettledCall,
} from "#harness/session-machine/transitions.js";
import type { SuspendedStep } from "#harness/session-machine/view.js";
import { validateHarnessModelMessages } from "#harness/messages.js";
import { openTurn, type Step } from "#harness/step/context.js";
import { prepareTurnInput } from "#harness/step/intake.js";
import { placeTurnInput } from "#harness/step/prompt.js";
import { SessionLimitDeclinedError } from "#harness/turn-cancellation.js";
import { bumpSessionRuntimeUsageLimits } from "#harness/turn-tag-state.js";
import type { HarnessToolMap, StepInput, StepResult } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { InputRequest } from "#shared/input.js";
import {
  answer,
  approvingSteps,
  dispatch,
  requireSignIn,
  stepForRequest,
  withdrawSignIns,
} from "./approvals.js";
import { runApprovedCalls } from "./approved-calls.js";
import { getApprovalAuditState, retireActiveCandidates } from "./candidates.js";
import { coordinateApprovalDelivery } from "./coordinator.js";
import { deliver } from "./delivery.js";

/**
 * What a delivery does before its turn runs. `stop` ends the step: the answers left nothing to
 * run yet, so the turn holds, or a responder must sign in first. `run` carries the turn's input,
 * without the answers the session took, and the approved work that runs once the turn opens.
 */
export type HumanInputIntake =
  | { readonly kind: "stop"; readonly result: StepResult }
  | {
      readonly kind: "run";
      readonly input: StepInput | undefined;
      /** The message the turn receives, as the stream shows it. */
      readonly message?: StepInput["message"];
      /** A plain-text answer consumed the message, so the model never reads it. */
      readonly consumedMessage: boolean;
      /** The delivery carries input for a turn. */
      readonly opensTurn: boolean;
      readonly approved: ApprovedWork;
    };

/** What the delivery approved: it runs once the delivery resumes the held turn. */
export interface ApprovedWork {
  readonly resolved: readonly ResolvedInputBatch[];
  readonly limit?: { readonly granted: boolean };
  /** The tools a parked step's calls run with: those of the step that asked. */
  readonly toolsOf: (step: SuspendedStep | undefined) => HarnessToolMap;
}

/**
 * Answers what the session asked: approval answers pass the response policies, and the session
 * decides which parked steps they resolve. Runs before the delivery joins its turn, so approved
 * calls get the tools of the step that asked.
 */
export async function acceptHumanInput(
  step: Step,
  input: StepInput | undefined,
  options: { readonly takeQueued: boolean },
): Promise<HumanInputIntake> {
  const { config, ctx } = step;
  // A sign-in completes first, at the coordinates of the turn it holds.
  const completions = config.signInCompletions ?? [];
  if (completions.length > 0) await step.apply(completeSignIn(step.view(), { completions }));
  const delivered = deliver(step.view(), input, options);
  // A new message reaching the held turn steers it: the sign-ins it waits on end, and its
  // unanswered approvals resolve with the answers below.
  const steered =
    input?.message !== undefined || delivered.displayMessage !== undefined
      ? await withdrawSteeredSignIns(step, delivered.input)
      : delivered.input;
  // Restoring a turn's tools runs its resolvers, so a step's tools are restored once, and again
  // only after another step's.
  const restoredTools = new Map<string, HarnessToolMap>();
  let restoredStep: string | undefined;
  const restoreTools = async (parked: SuspendedStep | undefined): Promise<HarnessToolMap> => {
    const at = parked?.event ?? step.position();
    const key = `${at.turnId}:${at.stepIndex}`;
    const restored = restoredTools.get(key);
    if (restored !== undefined && restoredStep === key) return restored;
    if (parked !== undefined) await config.prepareApprovalTurn?.(parked.event);
    if (ctx !== undefined) {
      await config.resolveStepDynamicTools?.({
        ctx,
        event: stepStartedForResolvers({
          modelId: step.session.agent.modelReference?.id ?? "dynamic",
          sequence: at.sequence,
          stepIndex: at.stepIndex,
          turnId: at.turnId,
        }),
        messages: step.projectHistory(step.session.history),
      });
    }
    const tools = buildResponseAuthorizationTools({ authoredTools: config.tools, context: ctx });
    restoredTools.set(key, tools);
    restoredStep = key;
    return tools;
  };
  const toolsOf = (parked: SuspendedStep | undefined) =>
    (parked && restoredTools.get(`${parked.event.turnId}:${parked.event.stepIndex}`)) ??
    config.tools;

  const challengesAtStart = step.view().signIns;
  const coordinated = await coordinateApprovalDelivery({
    session: step.session,
    stepInput: steered,
    tools: config.tools,
    prepareTools: (request) => restoreTools(stepForRequest(step.view(), request.requestId)),
  });
  step.session = coordinated.session;

  for (const parked of approvingSteps(step.view(), coordinated.stepInput)) {
    await restoreTools(parked);
  }
  const decision = answer(step.view(), {
    approvalKey: (request) =>
      toolsOf(stepForRequest(step.view(), request.requestId))
        .get(request.action.toolName)
        ?.approvalKey?.(request.action.input),
    delivery: coordinated.stepInput,
    policy: {
      ...coordinated,
      audit: getApprovalAuditState(step.session.state),
      challengesAtStart,
    },
    takeQueued: delivered.takeQueued,
  });
  for (const batch of decision.resolved) {
    await step.instrumentation?.publishInputResolutions({
      batch,
      sessionId: step.session.sessionId,
    });
  }
  await step.apply(decision);
  const stop = (result: StepResult): HumanInputIntake => ({ kind: "stop", result });
  switch (decision.next) {
    case "park":
      // A held turn's request is still open: a partial answer, or one a policy refused.
      if (step.view().projection.activeTurnId === undefined) {
        return stop({ next: null, session: step.session });
      }
      return stop(await holdForInput(step));
    case "repeat":
      return stop({ next: step.runStep, session: step.session });
    case "sign-in":
      await step.apply(
        requireSignIn(step.view(), {
          challenges: coordinated.challenges,
          queued: coordinated.stepInput,
        }),
      );
      return stop(held(step));
    case "defer-message": {
      // The message is received now, into a turn that holds for the budget prompt: the grant
      // resumes that turn, and the model reads the message from history.
      const turn = await prepareTurnInput(step, decision.input, { consumedMessage: false });
      const failed = await openTurn(step, {
        input: [...turn.ephemeral, ...turn.messages],
        message: delivered.displayMessage ?? decision.input?.message,
      });
      if (failed !== undefined) return stop(failed);
      step.session = {
        ...step.session,
        history: validateHarnessModelMessages(placeTurnInput(step, step.session.history, turn)),
      };
      return stop(await holdForInput(step));
    }
    case "continue":
      break;
  }
  return {
    approved: { limit: decision.limit, resolved: decision.resolved, toolsOf },
    consumedMessage: decision.consumedMessage === true,
    input: decision.input,
    message: delivered.displayMessage ?? delivered.input?.message,
    kind: "run",
    opensTurn: hasTurnInput(delivered.input) || hasTurnInput(coordinated.stepInput),
  };
}

/**
 * Runs what a delivery approved, in the turn it resumed. A session-limit answer grants a fresh
 * budget or ends the turn tree. eve runs approved calls itself before the model reads their
 * results, each with the tools of the step that asked; approved workflow calls join the runs
 * their steps wait on, and the turn's own input waits with them (`following`).
 */
export async function runApprovedWork(
  step: Step,
  work: ApprovedWork,
  following: readonly ModelMessage[],
): Promise<StepResult | undefined> {
  if (work.limit !== undefined) {
    if (!work.limit.granted) throw new SessionLimitDeclinedError();
    step.session = bumpSessionRuntimeUsageLimits(step.session);
  }

  const toolResults: TypedToolResult<ToolSet>[] = [];
  const settled: SettledCall[] = [];
  const workflowCalls: { tools: HarnessToolMap; turnId: string; requests: InputRequest[] }[] = [];
  for (const batch of work.resolved) {
    const approved = batch.inputs.filter((entry) => entry.outcome === "approved");
    if (approved.length === 0) continue;
    const tools = work.toolsOf(
      step
        .view()
        .turn.suspended.find(
          (parked) =>
            parked.event.turnId === batch.event.turnId &&
            parked.event.stepIndex === batch.event.stepIndex,
        ),
    );
    for (const { request } of approved) {
      if (!tools.has(request.action.toolName)) {
        throw new Error(
          "The approved tool is no longer available. Request a new tool call and approval.",
        );
      }
    }
    const requests = approved.map((entry) => entry.request);
    const isWorkflowCall = (request: InputRequest) =>
      tools.get(request.action.toolName)?.workflowId !== undefined;
    const executed = await runApprovedCalls({
      abortSignal: step.config.abortSignal,
      messages: step.projectHistory(step.session.history),
      position: step.position(),
      publish: step.publish,
      requests: requests.filter((request) => !isWorkflowCall(request)),
      tools,
    });
    settled.push(...executed.settled);
    toolResults.push(...executed.toolResults);
    workflowCalls.push({
      requests: requests.filter(isWorkflowCall),
      tools,
      turnId: batch.event.turnId,
    });
  }
  // Denied calls already hold their results, so a step they complete commits here too.
  await step.apply(settle(step.view(), { results: settled }));
  const signIn = resolveInlineAuthorizationInterrupt({ messages: [], toolResults });
  if (signIn !== undefined) {
    await step.apply(
      requireSignIn(step.view(), {
        callIdsByName: signIn.callIdsByName,
        challenges: signIn.challenges,
      }),
      step.session.history,
    );
    return held(step);
  }
  const tasks: RuntimeWorkflowTaskRequest[] = [];
  for (const { requests, tools, turnId } of workflowCalls) {
    if (requests.length === 0) continue;
    const deferred = collectDeferredCalls({
      session: step.session,
      toolCalls: requests.map(({ action }) => ({
        input: action.input,
        toolCallId: action.callId,
        toolName: action.toolName,
      })),
      tools,
      turnId,
    });
    step.session = deferred.session;
    tasks.push(...deferred.workflowRequests);
  }
  if (tasks.length > 0) await step.apply(dispatch(step.view(), { following, tasks }));
  return undefined;
}

const STEERED_SIGN_IN_REASON = "Cancelled because a new message arrived.";

/**
 * The held turn holds on, for a person to act on its sign-in, approval, or the session-limit
 * prompt; the session resumes it when they do.
 */
export async function holdForInput(step: Step): Promise<StepResult> {
  await step.apply(hold(step.view(), { on: "input" }));
  return held(step);
}

function held(step: Step): StepResult {
  return { held: { kind: "request" }, next: null, session: step.session };
}

/**
 * A message steers the held turn: the responders still checking its approvals stop, the sign-ins
 * it waits on end, declined, and the model learns why.
 */
async function withdrawSteeredSignIns(
  step: Step,
  input: StepInput | undefined,
): Promise<StepInput | undefined> {
  const names = [...new Set(step.view().signIns.map((challenge) => challenge.name))];
  step.session = {
    ...step.session,
    state: retireActiveCandidates(step.session.state, {
      completedAt: Date.now(),
      reason: STEERED_SIGN_IN_REASON,
    }),
  };
  if (names.length === 0) return input;
  await step.apply(withdrawSignIns(step.view(), STEERED_SIGN_IN_REASON));
  return {
    ...input,
    context: [
      ...(input?.context ?? []),
      `Sign-in to ${names.join(", ")} was cancelled because the user sent a new message instead. Ask to sign in again only if the new message still needs it.`,
    ],
  };
}

/** Whether the input carries user-facing turn input. */
function hasTurnInput(input: StepInput | undefined): boolean {
  if (input === undefined) return false;
  return input.message !== undefined || (input.inputResponses?.length ?? 0) > 0;
}
