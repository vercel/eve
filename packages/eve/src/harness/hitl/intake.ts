import { approvedClearance, type Clearance } from "#harness/clearance.js";
import { transition } from "#harness/session-machine/commit.js";
import { callRun, runTurn } from "#protocol/session-projection/selectors.js";
import { stepCatalog } from "#definitions/step.js";
import { SEARCH_TOOL_NAME } from "#protocol/catalog-tools.js";
import { collectWorkflowCalls } from "#harness/coordination.js";
import { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import { completeSignIn, runnableCalls, settle } from "#harness/session-machine/transitions.js";
import {
  type ApprovedCall,
  type SessionView,
  type SuspendedStep,
} from "#harness/session-machine/view.js";
import { signInAttemptKey } from "#harness/hitl/sign-ins.js";
import { signInInteractionId } from "#harness/interaction-facts.js";
import type { Step } from "#harness/step/context.js";
import { park } from "#harness/step/park.js";
import { SessionLimitDeclinedError, throwIfTurnAborted } from "#harness/turn-cancellation.js";
import type { HarnessToolLookup, HarnessStepInput, StepResult } from "#harness/types.js";
import type { StepCatalog } from "#execution/catalog/step-catalog.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import { applyEndingSignIns, stepCallsBack } from "./sign-in-callbacks.js";
import {
  admitAnswers,
  dispatch,
  approvalMemory,
  openLimit,
  queueInput,
  requireSignIn,
  type RunnableCall,
  settleApprovals,
  settleLimit,
  withdrawSignIns,
  withdrawUnavailable,
} from "./approvals.js";
import { runApprovedCalls, signInReports } from "./approved-calls.js";
import { getAuthorizationResults, SignInCompletedKey } from "#harness/authorization.js";
import { publishDenial, type CallResult } from "#harness/call-executor.js";
import { checkResponders, weighResponders } from "./responders.js";
import {
  compactInput,
  deliver,
  resolveTextInput,
  resolveTypedApproval,
  type ResolvedStepInput,
  withoutResponses,
} from "./delivery.js";
import { decideApproval } from "#harness/tools.js";
import { changedSinceOffered, changedToolMessage, failedCall } from "#harness/approval-outcome.js";
import { settleCall } from "#harness/session-machine/calls.js";

export type HumanInputIntake =
  | { readonly kind: "stop"; readonly result: StepResult }
  | {
      readonly kind: "run";
      readonly input: HarnessStepInput | undefined;
      readonly message?: HarnessStepInput["message"];
      readonly consumedMessage: boolean;
      readonly opensTurn: boolean;
      readonly steer: boolean;
    };

export async function admitHumanInput(
  step: Step,
  input: HarnessStepInput | undefined,
  options: { readonly takeQueued: boolean },
): Promise<HumanInputIntake> {
  const { config } = step;
  const completions = config.signInCompletions ?? [];
  if (completions.length > 0) {
    const refusals = new Map(
      getAuthorizationResults().flatMap(({ attemptId, callback }) =>
        callback.params.error === undefined ? [] : [[attemptId, callback.params.error] as const],
      ),
    );
    await step.apply(completeSignIn(step.view(), { completions, refusals }));
  }
  const weighed = await weighResponders(step.view(), {
    now: Date.now(),
    tools: () => toolsOf(step),
  });
  await step.apply(weighed);
  if (weighed.unavailable.length > 0) {
    const searchable = (await toolsOf(step)).get(SEARCH_TOOL_NAME) !== undefined;
    await step.apply(
      withdrawUnavailable(step.view(), {
        interactionIds: weighed.unavailable,
        searchable,
      }),
    );
  }
  if (weighed.challenges.length > 0) {
    await applyEndingSignIns(
      step,
      requireSignIn(step.view(), {
        challenges: weighed.challenges,
        callsBack: stepCallsBack(step),
        queued: input,
      }),
    );
    return { kind: "stop", result: await park(step) };
  }
  const typedAnswers = config.typedAnswers !== false;
  const delivered = deliver(step.view(), input, { ...options, typedAnswers });
  if (delivered.takeQueued && step.view().turn.queued !== undefined) {
    await step.apply(transition({ events: [], turn: { ...step.view().turn, queued: undefined } }));
  }
  const typed = typedAnswers ? resolveTypedApproval(step.view(), delivered.input) : delivered.input;
  const limit = openLimit(step.view());
  const messaged =
    (delivered.input?.message !== undefined && typed?.message !== undefined) ||
    delivered.displayMessage !== undefined;
  const steer = messaged && limit === undefined;
  const steered = steer ? await withdrawSteeredSignIns(step, typed) : typed;

  const answered: ResolvedStepInput | undefined =
    limit === undefined || !typedAnswers
      ? steered
      : resolveTextInput(step.view().projection.view, steered);
  const check = checkResponders(step.view(), answered, Date.now());
  await step.apply(admitAnswers(step.view(), { check, delivery: answered }));
  if (Object.keys(check.weigh).length > 0) {
    await step.apply(queueInput(step.view(), compactInput(withoutResponses(answered))));
    return { kind: "stop", result: { next: step.runStep, session: step.session } };
  }
  const consumedMessage = answered?.messageConsumed === true;
  return {
    consumedMessage,
    input: withoutResponses(answered),
    kind: "run",
    message: consumedMessage ? undefined : (delivered.displayMessage ?? delivered.input?.message),
    opensTurn: hasTurnInput(delivered.input) || hasTurnInput(steered),
    steer: steer && !consumedMessage,
  };
}

export interface HumanDecisions {
  readonly limit?: { readonly granted: boolean };
  readonly approved: readonly RunnableCall[];
  readonly settledApprovals: boolean;
}

export async function settleHumanInput(
  step: Step,
  intake: Extract<HumanInputIntake, { readonly kind: "run" }>,
): Promise<HumanDecisions> {
  const limit = settleLimit(step.view());
  if (limit.events.length > 0) await step.apply(limit);
  if (step.view().turn.suspended.length > 0) await toolsOf(step);
  const settled = settleApprovals(step.view(), {
    steer: intake.steer,
  });
  await step.apply(settled);
  const view = step.view();
  const resumed = view.turn.suspended.flatMap((parked) =>
    runnableCalls(view, parked).map((approval) => ({ approval, step: parked })),
  );
  return {
    approved: [...settled.approved, ...resumed],
    limit: limit.limit,
    settledApprovals: settled.answered,
  };
}

export async function applyHumanDecisions(
  step: Step,
  decided: HumanDecisions,
): Promise<StepResult | undefined> {
  if (decided.limit?.granted === false) throw new SessionLimitDeclinedError();
  await step.apply(settle(step.view(), { results: [] }));
  return runApproved(step, decided.approved);
}

async function runApproved(
  step: Step,
  approved: readonly RunnableCall[],
): Promise<StepResult | undefined> {
  if (approved.length === 0) return undefined;
  const byStep = new Map<SuspendedStep, ApprovedCall[]>();
  for (const { approval, step: parked } of approved) {
    byStep.set(parked, [...(byStep.get(parked) ?? []), approval]);
  }
  const tasks: RuntimeWorkflowTaskRequest[] = [];
  const denied: CallResult[] = [];
  const local: { approvals: ApprovedCall[]; tools: HarnessToolLookup }[] = [];
  const claimed = new Set<string>();
  for (const [parked, approvals] of byStep) {
    const tools = await toolsOf(step);
    const workflows = new Map<string, { approval: ApprovedCall; clearance: Clearance }>();
    for (const approval of approvals) {
      const tool = tools.get(approval.call.toolName);
      if (tool?.workflowId === undefined) continue;
      if (changedSinceOffered(approval.call, tool)) {
        const { callId, toolName } = approval.call;
        const failed = failedCall({ callId, message: changedToolMessage(toolName), toolName });
        await step.publish(settleCall(failed.result));
        denied.push({ part: failed.part });
        continue;
      }
      const recheck = await decideApproval(tool, {
        recheck: true,
        abortSignal: step.config.abortSignal,
        approvalMemory: approvalMemory(step.view()),
        callId: approval.call.callId,
        input: approval.call.input,
      });
      if (recheck.denied) {
        denied.push(
          ...(
            await publishDenial(approval.call, {
              publish: step.publish,
              reason: recheck.reason,
            })
          ).settled,
        );
      } else {
        const clearance =
          approvedClearance(step.view().projection.view, approval.call.callId) ?? recheck.clearance;
        if (clearance === undefined)
          throw new Error(`Approved call "${approval.call.callId}" has no clearance to dispatch.`);
        workflows.set(approval.call.callId, { approval, clearance });
      }
    }
    local.push({
      approvals: approvals
        .filter((approval) => tools.get(approval.call.toolName)?.workflowId === undefined)
        .map((approval) => reportingOnce(step.view(), approval, claimed)),
      tools,
    });
    if (workflows.size === 0) continue;
    const dispatched = collectWorkflowCalls({
      clearances: Object.fromEntries(
        [...workflows.entries()].map(([callId, { clearance }]) => [callId, clearance]),
      ),
      session: step.session,
      toolCalls: [...workflows.values()].map(({ approval: { call } }) => ({
        input: call.input,
        toolCallId: call.callId,
        toolName: call.toolName,
      })),
      tools,
      turnId: parked.event.turnId,
    });
    step.session = dispatched.session;
    tasks.push(...dispatched.workflowRequests);
  }
  if (denied.length > 0) await step.apply(settle(step.view(), { results: denied }));
  if (tasks.length > 0) await step.apply(dispatch(step.view(), { tasks }));

  const calls = local.flatMap(({ approvals }) => approvals);
  step.frameworkToolNames = new Set(
    local.flatMap(({ approvals, tools }) =>
      approvals
        .map((approval) => approval.call.toolName)
        .filter((name) => tools.get(name)?.frameworkTool === true),
    ),
  );
  if (calls.length === 0) return undefined;
  const signIns = signInReports({ publish: step.publish, view: () => step.view() });
  step.ctx.setVirtualContext(
    SignInCompletedKey,
    signIns.completed(calls.flatMap((call) => call.signIns ?? [])),
  );
  const groups = await Promise.allSettled(
    local.map(async ({ approvals, tools }) => {
      if (approvals.length === 0) return { settled: [], signIns: [] };
      const view = step.view().projection.view;
      const call = view.calls[approvals[0]!.call.callId];
      const runId = call === undefined ? undefined : callRun(view, call);
      const run = runId === undefined ? undefined : view.runs[runId];
      const attempt =
        run?.attempt === undefined
          ? undefined
          : step.instrumentation?.prepareAttempt({
              runId: run.runId,
              attempt: run.attempt,
              stepIndex: run.step,
              turnId: runTurn(view, run.runId),
              isFrameworkTool: (name) => step.frameworkToolNames.has(name),
            });
      return await runApprovedCalls({
        abortSignal: step.config.abortSignal,
        approvalMemory: approvalMemory(step.view()),
        approvals,
        messages: step.session.history,
        publish: step.publish,
        responderOf: (approval) => approval.responder,
        telemetry: attempt?.telemetry,
        signIns,
        tools,
        view: () => step.view(),
      });
    }),
  );
  step.ctx.delete(SignInCompletedKey);
  const executed = groups.map((group) => {
    if (group.status === "rejected") throw group.reason;
    return group.value;
  });
  await step.apply(settle(step.view(), { results: executed.flatMap((run) => run.settled) }));
  throwIfTurnAborted(step.config.abortSignal);
  const signIn = resolveInlineAuthorizationInterrupt({
    signIns: executed.flatMap((run) => run.signIns),
  });
  if (signIn === undefined) return undefined;
  const byCallId = new Map(calls.map((approval) => [approval.call.callId, approval]));
  await applyEndingSignIns(
    step,
    requireSignIn(step.view(), {
      calls: signIn.calls.map((stopped) => {
        const approval = byCallId.get(stopped.call.callId);
        return approval === undefined ? stopped : { ...stopped, approval };
      }),
      challenges: signIn.challenges,
      callsBack: stepCallsBack(step),
    }),
    step.session.history,
  );
  return park(step);
}

function reportingOnce(view: SessionView, call: ApprovedCall, claimed: Set<string>): ApprovedCall {
  const { interactions } = view.projection.view;
  const signIns = (call.signIns ?? []).filter((challenge) => {
    const key = signInAttemptKey(challenge);
    const open = interactions[signInInteractionId(challenge)]?.status === "open";
    if (claimed.has(key) || !open) return false;
    claimed.add(key);
    return true;
  });
  return { ...call, signIns };
}

const stepTools = new WeakMap<Step, Promise<StepCatalog>>();

function toolsOf(step: Step): Promise<StepCatalog> {
  let tools = stepTools.get(step);
  if (tools === undefined) {
    tools = stepCatalog(step);
    stepTools.set(step, tools);
    tools.catch(() => stepTools.delete(step));
  }
  return tools;
}

const STEERED_SIGN_IN_REASON = "Cancelled because a new message arrived.";

async function withdrawSteeredSignIns(
  step: Step,
  input: HarnessStepInput | undefined,
): Promise<HarnessStepInput | undefined> {
  const names = [...new Set(step.view().signIns.map((challenge) => challenge.name))];
  if (names.length === 0) return input;
  await applyEndingSignIns(step, withdrawSignIns(step.view(), STEERED_SIGN_IN_REASON));
  return {
    ...input,
    context: [
      ...(input?.context ?? []),
      `Sign-in to ${names.join(", ")} was cancelled because the user sent a new message instead, and it won't be asked for again in this turn. If the new message still needs it, tell the user the action needs that access and that they can ask again to sign in.`,
    ],
  };
}

function hasTurnInput(input: HarnessStepInput | undefined): boolean {
  if (input === undefined) return false;
  return input.message !== undefined || (input.answers?.length ?? 0) > 0;
}
