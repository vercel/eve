import { callRun, runTurn } from "#protocol/session-projection/selectors.js";
import { buildStepCatalog } from "#execution/catalog/step-catalog.js";
import { SEARCH_TOOL_NAME } from "#protocol/catalog-tools.js";
import { collectWorkflowCalls } from "#harness/coordination.js";
import { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import { completeSignIn, runnableCalls, settle } from "#harness/session-machine/transitions.js";
import {
  stepForRequest,
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
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { ClearedBy } from "#protocol/session-events/families/call.js";
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
import { runApprovedCalls } from "./approved-calls.js";
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
import { callSettledFrom } from "#harness/call-facts.js";

/**
 * What a delivery leaves for its step once its answers are admitted. `stop` ends the step: a
 * response policy committed and runs next step, or a responder must sign in first. `run` carries
 * the turn's input, without the answers, and whether a message steers the turn.
 */
export type HumanInputIntake =
  | { readonly kind: "stop"; readonly result: StepResult }
  | {
      readonly kind: "run";
      readonly input: HarnessStepInput | undefined;
      /** The message the turn receives, as the stream shows it. */
      readonly message?: HarnessStepInput["message"];
      /** A plain-text answer consumed the message, so the model never reads it. */
      readonly consumedMessage: boolean;
      /** The delivery carries input for a turn. */
      readonly opensTurn: boolean;
      /** A message steers the turn past what it waits on. */
      readonly steer: boolean;
    };

/**
 * Admits a delivery's answers: a sign-in callback completes its sign-in, a stale answer becomes
 * text, a typed one the answer it stands for, and each answer stands once its checks and response
 * policy allow it. Nothing is decided here; `settleHumanInput` decides.
 */
export async function admitHumanInput(
  step: Step,
  input: HarnessStepInput | undefined,
  options: { readonly takeQueued: boolean },
): Promise<HumanInputIntake> {
  const { config } = step;
  // A sign-in completes first, at the coordinates of the turn it holds.
  const completions = config.signInCompletions ?? [];
  if (completions.length > 0) await step.apply(completeSignIn(step.view(), { completions }));
  // Answers a response policy weighs meet it first, as a responder's sign-in callback resumes.
  const weighed = await weighResponders(step.view(), {
    now: Date.now(),
    toolsOf: (parked) => restoreTools(step, parked),
  });
  await step.apply(weighed);
  if (weighed.unavailable.length > 0) {
    await step.apply(
      withdrawUnavailable(step.view(), {
        interactionIds: weighed.unavailable,
        searchable: (request) =>
          toolsOf(step, stepForRequest(step.view(), request.interactionId)).get(
            SEARCH_TOOL_NAME,
          ) !== undefined,
      }),
    );
  }
  if (weighed.challenges.length > 0) {
    await step.apply(requireSignIn(step.view(), { challenges: weighed.challenges, queued: input }));
    return { kind: "stop", result: await park(step) };
  }
  const typedAnswers = config.typedAnswers !== false;
  const delivered = deliver(step.view(), input, { ...options, typedAnswers });
  if (delivered.takeQueued && step.view().turn.queued !== undefined) {
    await step.apply({ events: [], turn: { ...step.view().turn, queued: undefined } });
  }
  // A typed approval answers like a press, so the approval's response policy decides it.
  const typed = typedAnswers ? resolveTypedApproval(step.view(), delivered.input) : delivered.input;
  const limit = openLimit(step.view());
  // A new message steers the held turn, unless it waits behind the budget prompt. A typed answer
  // is not a new message. A message queued behind a policy's answer or a responder's sign-in
  // still steers: without it, the turn re-runs a step that parks again, forever.
  const messaged =
    (delivered.input?.message !== undefined && typed?.message !== undefined) ||
    delivered.displayMessage !== undefined;
  const steer = messaged && limit === undefined;
  const steered = steer ? await withdrawSteeredSignIns(step, typed) : typed;

  // A typed answer to the budget prompt is an answer like a press.
  const answered: ResolvedStepInput | undefined =
    limit === undefined || !typedAnswers
      ? steered
      : resolveTextInput(step.view().projection.view, steered);
  // Who gave each answer decides whether it stands now, waits for a response policy, or is
  // refused.
  const check = checkResponders(step.view(), answered, Date.now());
  await step.apply(admitAnswers(step.view(), { check, delivery: answered }));
  if (Object.keys(check.weigh).length > 0) {
    // The answers are recorded before any policy runs: the next step weighs them, with the rest
    // of the delivery.
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

/**
 * What the person decided: the budget answer, and the calls that run now: those they approved,
 * and those a sign-in stopped whose sign-ins have called back.
 */
export interface HumanDecisions {
  readonly limit?: { readonly granted: boolean };
  readonly approved: readonly RunnableCall[];
  /** Approvals settled on their answers: the model reads their results before the turn input. */
  readonly settledApprovals: boolean;
}

/**
 * The person's standing answers decide what they answer: the budget prompt settles, and each
 * step's approvals settle together once each has an answer, or when a message steers past them.
 * A call a sign-in stopped runs once its sign-ins have called back, as the call that asked.
 */
export async function settleHumanInput(
  step: Step,
  intake: Extract<HumanInputIntake, { readonly kind: "run" }>,
): Promise<HumanDecisions> {
  const limit = settleLimit(step.view());
  if (limit.events.length > 0) await step.apply(limit);
  // Approved calls run with the tools of the step that asked, built before anything runs.
  for (const parked of step.view().turn.suspended) await restoreTools(step, parked);
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

/**
 * What the decisions do once the turn has the delivery: a budget answer grants a fresh budget or
 * ends the turn tree, the steps denials completed commit, and approved calls run.
 */
export async function applyHumanDecisions(
  step: Step,
  decided: HumanDecisions,
): Promise<StepResult | undefined> {
  // A grant needs no write: its accepted budget prompt started the new window.
  if (decided.limit?.granted === false) throw new SessionLimitDeclinedError();
  await step.apply(settle(step.view(), { results: [] }));
  return runApproved(step, decided.approved);
}

/**
 * Runs the calls cleared to run, each with the tools of the step that asked and as the turn's
 * requester: workflow and agent calls join the runs their steps wait on, and local calls run
 * here, in the step's first attempt. A call that needs a sign-in stops the turn for it, and
 * waits in its step until the sign-in calls back.
 */
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
    const tools = toolsOf(step, parked);
    const workflows = new Map<string, { approval: ApprovedCall; clearedBy?: ClearedBy }>();
    for (const approval of approvals) {
      const tool = tools.get(approval.call.toolName);
      if (tool?.workflowId === undefined) continue;
      if (changedSinceOffered(approval.call, tool)) {
        const { callId, toolName } = approval.call;
        const failed = failedCall({ callId, message: changedToolMessage(toolName), toolName });
        await step.publish(callSettledFrom(failed.result));
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
        workflows.set(approval.call.callId, {
          approval,
          clearedBy:
            approval.interactionId === undefined
              ? recheck.clearedBy
              : { interactionId: approval.interactionId },
        });
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
    tasks.push(
      ...dispatched.workflowRequests.map((task) => ({
        ...task,
        clearedBy: workflows.get(task.callId)?.clearedBy,
      })),
    );
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
  const executed = await Promise.all(
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
        tools,
        view: () => step.view(),
      });
    }),
  );
  await step.apply(settle(step.view(), { results: executed.flatMap((run) => run.settled) }));
  // A cancellation ends the turn once the calls it cut short have their results.
  throwIfTurnAborted(step.config.abortSignal);
  const signIn = resolveInlineAuthorizationInterrupt({
    signIns: executed.flatMap((run) => run.signIns),
  });
  if (signIn === undefined) return undefined;
  // A stopped call keeps the approval it ran on, so it runs on it again after the sign-in.
  const byCallId = new Map(calls.map((approval) => [approval.call.callId, approval]));
  await step.apply(
    requireSignIn(step.view(), {
      calls: signIn.calls.map((stopped) => {
        const approval = byCallId.get(stopped.call.callId);
        return approval === undefined ? stopped : { ...stopped, approval };
      }),
      challenges: signIn.challenges,
    }),
    step.session.history,
  );
  return park(step);
}

/**
 * Calls a sign-in stopped can share it, and it reports once: with the first call to run it, unless
 * a call that ran earlier reported it (its interaction is no longer open). `claimed` holds the
 * sign-ins the calls in this batch already took.
 */
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

// A step's catalog is built once per suspended step. Restoring a step's tools runs its
// resolvers, so a step's tools restore again only after another step's.
const restoredTools = new WeakMap<
  Step,
  { readonly tools: Map<string, HarnessToolLookup>; last?: string }
>();

function stepKey(at: { readonly turnId: string; readonly stepIndex: number }): string {
  return `${at.turnId}:${at.stepIndex}`;
}

/** The entries of the step that asked, built once per step; the running step's without one. */
async function restoreTools(
  step: Step,
  parked: SuspendedStep | undefined,
): Promise<HarnessToolLookup> {
  const { config } = step;
  const at = parked?.event ?? step.position();
  const key = stepKey(at);
  const cache = restoredTools.get(step) ?? { tools: new Map<string, HarnessToolLookup>() };
  restoredTools.set(step, cache);
  const restored = cache.tools.get(key);
  if (restored !== undefined && cache.last === key) return restored;
  const tools = buildStepCatalog({
    agentTools: config.tools,
    ctx: step.ctx,
    endsTurn: false,
    session: step.session,
  });
  cache.tools.set(key, tools);
  cache.last = key;
  return tools;
}

/** The entries a parked step's calls run with: those of the step that asked. */
function toolsOf(step: Step, parked: SuspendedStep | undefined): HarnessToolLookup {
  return (parked && restoredTools.get(step)?.tools.get(stepKey(parked.event))) ?? step.config.tools;
}

const STEERED_SIGN_IN_REASON = "Cancelled because a new message arrived.";

/**
 * A message steers the held turn: the sign-ins it waits on end, declined, and the model learns
 * why. The answers responders still wait on close with the approvals they answer.
 */
async function withdrawSteeredSignIns(
  step: Step,
  input: HarnessStepInput | undefined,
): Promise<HarnessStepInput | undefined> {
  const names = [...new Set(step.view().signIns.map((challenge) => challenge.name))];
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
function hasTurnInput(input: HarnessStepInput | undefined): boolean {
  if (input === undefined) return false;
  return input.message !== undefined || (input.answers?.length ?? 0) > 0;
}
