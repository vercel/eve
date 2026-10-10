import { buildStepCatalog } from "#execution/catalog/step-catalog.js";
import { SEARCH_TOOL_NAME } from "#protocol/catalog-tools.js";
import { collectWorkflowCalls } from "#harness/coordination.js";
import { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import { stepStartedForResolvers } from "#harness/session-machine/resolver-events.js";
import {
  approvedCalls,
  completeSignIn,
  hold,
  settle,
} from "#harness/session-machine/transitions.js";
import type { SuspendedStep } from "#harness/session-machine/view.js";
import { validateHarnessModelMessages } from "#harness/messages.js";
import { openTurn, type Step } from "#harness/step/context.js";
import { prepareTurnInput } from "#harness/step/intake.js";
import { placeTurnInput } from "#harness/step/prompt.js";
import { SessionLimitDeclinedError, throwIfTurnAborted } from "#harness/turn-cancellation.js";
import { bumpSessionRuntimeUsageLimits } from "#harness/turn-tag-state.js";
import type { HarnessToolLookup, StepInput, StepResult } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import {
  answer,
  approvingSteps,
  grantedApprovalKeys,
  dispatch,
  requireSignIn,
  deferInput,
  stepForRequest,
  withdrawSignIns,
} from "./approvals.js";
import { rejectApprovedCall, runApprovedCalls, type ApprovedCallResult } from "./approved-calls.js";
import { getApprovalAuditState, retireActiveCandidates } from "./candidates.js";
import { coordinateApprovalDelivery } from "./coordinator.js";
import { deliver, resolveTypedApproval, turnInputOnly, withoutTurnInput } from "./delivery.js";
import { recheckApprovedCall } from "#harness/tools.js";
import type { InputRequest } from "#shared/input.js";
import type { InstrumentationAttempt } from "#instrumentation/runtime.js";
import { activeTurnId } from "#harness/session-machine/view.js";

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

/**
 * What the delivery decided: the session-limit answer, and the tools approved calls run with.
 * The calls themselves wait in their suspended steps until the turn's next model step.
 */
export interface ApprovedWork {
  readonly limit?: { readonly granted: boolean };
  /** The entries a parked step's calls run with: those of the step that asked. */
  readonly toolsOf: (step: SuspendedStep | undefined) => HarnessToolLookup;
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
  // A typed approval answers like a press, so the approval's response policy decides it.
  const typed = resolveTypedApproval(step.view(), delivered.input);
  // A new message reaching the held turn steers it: the sign-ins it waits on end, and its
  // unanswered approvals resolve with the answers below. A typed answer is not a new message.
  const steered =
    (input?.message !== undefined && typed?.message !== undefined) ||
    delivered.displayMessage !== undefined
      ? await withdrawSteeredSignIns(step, typed)
      : typed;
  // Restoring a turn's tools runs its resolvers, so a step's tools are restored once, and again
  // only after another step's.
  const restoredTools = new Map<string, HarnessToolLookup>();
  let restoredStep: string | undefined;
  const restoreTools = async (parked: SuspendedStep | undefined): Promise<HarnessToolLookup> => {
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
    const tools = buildStepCatalog({
      agentTools: config.tools,
      ctx,
      endsTurn: false,
      session: step.session,
    });
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
    searchable: (request) =>
      toolsOf(stepForRequest(step.view(), request.requestId)).get(SEARCH_TOOL_NAME) !== undefined,
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
      // Approved calls wait behind the budget prompt, and the message waits behind them.
      if (approvedCalls(step.view().turn).length > 0) {
        const deferred = turnInputOnly(decision.input);
        if (deferred !== undefined) await step.apply(deferInput(step.view(), deferred));
        return stop({ next: null, session: step.session });
      }
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
  // Approved calls run with the tools of the step that asked, including calls approved by an
  // earlier delivery whose turn the budget stopped.
  for (const parked of step.view().turn.suspended) {
    if ((parked.approved?.length ?? 0) > 0) await restoreTools(parked);
  }
  // What the answers resolved comes before the delivery's own input, as with the AI SDK: the model
  // reads the approved calls' results and the denials first, and the input waits a step. A
  // message that steers past unanswered approvals joins this step.
  const answeredApprovals = decision.resolved.some(
    (batch) =>
      batch.inputs.some((entry) => entry.request.kind === "tool-approval") &&
      batch.inputs.every((entry) => entry.response !== undefined),
  );
  const deferred =
    answeredApprovals || approvedCalls(step.view().turn).length > 0
      ? turnInputOnly(decision.input)
      : undefined;
  if (deferred !== undefined) await step.apply(deferInput(step.view(), deferred));
  return {
    approved: { limit: decision.limit, toolsOf },
    consumedMessage: decision.consumedMessage === true,
    input: deferred === undefined ? decision.input : withoutTurnInput(decision.input),
    message:
      decision.consumedMessage === true || deferred !== undefined
        ? undefined
        : (delivered.displayMessage ?? delivered.input?.message),
    kind: "run",
    opensTurn: hasTurnInput(delivered.input) || hasTurnInput(coordinated.stepInput),
  };
}

/**
 * Admits what a delivery decided before its turn calls the model: a session-limit answer grants a
 * fresh budget or ends the turn tree, and a step its answers completed, as denials do, commits.
 */
export async function admitApprovedWork(step: Step, work: ApprovedWork): Promise<void> {
  if (work.limit !== undefined) {
    if (!work.limit.granted) throw new SessionLimitDeclinedError();
    step.session = bumpSessionRuntimeUsageLimits(step.session);
  }
  await step.apply(settle(step.view(), { results: [] }));
}

/** Whether a suspended step holds approved calls that haven't run. */
export function hasApprovedWork(step: Step): boolean {
  return approvedCalls(step.view().turn).length > 0;
}

/**
 * Approved workflow and agent calls join the runs their steps wait on, once the step has started
 * and before its budget check. Returns whether any did: the turn then waits on the runtime, and
 * approved local calls run after their results arrive.
 */
export async function dispatchApprovedWorkflows(step: Step, work: ApprovedWork): Promise<boolean> {
  const tasks: RuntimeWorkflowTaskRequest[] = [];
  const denied: ApprovedCallResult[] = [];
  for (const parked of step.view().turn.suspended) {
    const tools = work.toolsOf(parked);
    const requests: InputRequest[] = [];
    for (const request of parked.approved ?? []) {
      const tool = tools.get(request.action.toolName);
      if (tool?.workflowId === undefined) continue;
      const recheck = await recheckApprovedCall(tool, {
        abortSignal: step.config.abortSignal,
        callId: request.action.callId,
        input: request.action.input,
        approvedTools: grantedApprovalKeys(step.view(), (approved) =>
          tools.get(approved.action.toolName)?.approvalKey?.(approved.action.input),
        ),
      });
      if (recheck.denied) {
        denied.push(
          await rejectApprovedCall({
            request,
            reason: recheck.reason,
            position: step.position(),
            publish: step.publish,
          }),
        );
      } else requests.push(request);
    }
    if (requests.length === 0) continue;
    const dispatched = collectWorkflowCalls({
      session: step.session,
      toolCalls: requests.map(({ action }) => ({
        input: action.input,
        toolCallId: action.callId,
        toolName: action.toolName,
      })),
      tools,
      turnId: parked.event.turnId,
    });
    step.session = dispatched.session;
    tasks.push(...dispatched.workflowRequests);
  }
  if (denied.length > 0) await step.apply(settle(step.view(), { results: denied }));
  if (tasks.length === 0) return false;
  await step.apply(dispatch(step.view(), { tasks }));
  if (tasks.some((task) => task.entry.entryPoint === "execute")) {
    await step.apply(hold(step.view(), { on: "tasks" }));
  }
  return true;
}

/**
 * Runs approved local calls once the step has started and its budget allows it, as the AI SDK ran
 * them before the model read their results: each with the tools of the step that asked, as
 * the turn's requester, and in the step's first attempt. A call that needs a sign-in holds the
 * turn.
 */
export async function runApprovedLocalCalls(
  step: Step,
  work: ApprovedWork,
  setAttemptScope: (scope: InstrumentationAttempt | undefined) => void,
): Promise<StepResult | undefined> {
  const local = step.view().turn.suspended.map((parked) => {
    const tools = work.toolsOf(parked);
    const requests = (parked.approved ?? []).filter(
      (request) => tools.get(request.action.toolName)?.workflowId === undefined,
    );
    return { requests, tools };
  });
  const approved = local.flatMap(({ requests }) => requests);
  step.frameworkToolNames = new Set(
    local.flatMap(({ requests, tools }) =>
      requests
        .map((request) => request.action.toolName)
        .filter((name) => tools.get(name)?.frameworkTool === true),
    ),
  );
  const position = step.position();
  const attempt =
    approved.length === 0
      ? undefined
      : step.instrumentation?.prepareAttempt({
          isFrameworkTool: (name) => step.frameworkToolNames.has(name),
          attemptIndex: 0,
          stepIndex: position.stepIndex,
          turnId: activeTurnId(position),
        });
  if (attempt !== undefined) setAttemptScope(attempt.scope);
  const executed = await Promise.all(
    local.map(async ({ requests, tools }) => {
      if (requests.length === 0) return { settled: [], toolResults: [] };
      return await runApprovedCalls({
        abortSignal: step.config.abortSignal,
        approvedTools: grantedApprovalKeys(step.view(), (request) =>
          tools.get(request.action.toolName)?.approvalKey?.(request.action.input),
        ),
        messages: step.projectHistory(step.session.history),
        position: step.position(),
        publish: step.publish,
        requests,
        telemetry: attempt?.telemetry,
        tools,
      });
    }),
  );
  await step.apply(settle(step.view(), { results: executed.flatMap((run) => run.settled) }));
  // A cancellation ends the turn once the calls it cut short have their results.
  throwIfTurnAborted(step.config.abortSignal);
  const signIn = resolveInlineAuthorizationInterrupt({
    messages: [],
    toolResults: executed.flatMap((run) => run.toolResults),
  });
  if (signIn === undefined) return undefined;
  await step.apply(
    requireSignIn(step.view(), {
      callIdsByName: signIn.callIdsByName,
      challenges: signIn.challenges,
    }),
    step.session.history,
  );
  return held(step);
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
