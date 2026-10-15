import { buildStepCatalog } from "#execution/catalog/step-catalog.js";
import { SEARCH_TOOL_NAME } from "#protocol/catalog-tools.js";
import { collectWorkflowCalls } from "#harness/coordination.js";
import { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import { completeSignIn, settle } from "#harness/session-machine/transitions.js";
import type { SuspendedStep } from "#harness/session-machine/view.js";
import type { Step } from "#harness/step/context.js";
import { park } from "#harness/step/park.js";
import { SessionLimitDeclinedError, throwIfTurnAborted } from "#harness/turn-cancellation.js";
import { bumpSessionRuntimeUsageLimits } from "#harness/turn-tag-state.js";
import type { HarnessToolLookup, HarnessStepInput, StepResult } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import {
  admitAnswers,
  type ApprovedCall,
  dispatch,
  grantedApprovalKeys,
  openLimit,
  queueInput,
  requireSignIn,
  settleApprovals,
  settleLimit,
  stepForRequest,
  withdrawSignIns,
  withdrawUnavailable,
} from "./approvals.js";
import { rejectApprovedCall, runApprovedCalls, type ApprovedCallResult } from "./approved-calls.js";
import { checkResponders, weighResponders } from "./responders.js";
import {
  compactInput,
  deliver,
  resolveTextInput,
  resolveTypedApproval,
  type ResolvedStepInput,
  withoutResponses,
} from "./delivery.js";
import { recheckApprovedCall } from "#harness/tools.js";
import { activeTurnId } from "#harness/session-machine/view.js";

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
  const delivered = deliver(step.view(), input, options);
  if (delivered.takeQueued && step.view().turn.queued !== undefined) {
    await step.apply({ events: [], turn: { ...step.view().turn, queued: undefined } });
  }
  // A typed approval answers like a press, so the approval's response policy decides it.
  const typed = resolveTypedApproval(step.view(), delivered.input);
  const limit = openLimit(step.view());
  // A new message steers the held turn, unless it waits behind the budget prompt. A typed answer
  // is not a new message.
  const messaged =
    (input?.message !== undefined && typed?.message !== undefined) ||
    delivered.displayMessage !== undefined;
  const steer = messaged && limit === undefined;
  const steered = steer ? await withdrawSteeredSignIns(step, typed) : typed;

  // A typed answer to the budget prompt is an answer like a press.
  const answered: ResolvedStepInput | undefined =
    limit === undefined ? steered : resolveTextInput(step.view().projection.view, steered);
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

/** What the person decided: the budget answer, and the calls they approved. */
export interface HumanDecisions {
  readonly limit?: { readonly granted: boolean };
  readonly approved: readonly ApprovedCall[];
  /** Approvals settled on their answers: the model reads their results before the turn input. */
  readonly settledApprovals: boolean;
}

/**
 * The person's standing answers decide what they answer: the budget prompt settles, and each
 * step's approvals settle together once each has an answer, or when a message steers past them.
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
    approvalKey: (request) =>
      toolsOf(step, stepForRequest(step.view(), request.interactionId))
        .get(request.call.toolName)
        ?.approvalKey?.(request.call.input),
    steer: intake.steer,
  });
  await step.apply(settled);
  return {
    approved: settled.approved,
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
  if (decided.limit !== undefined) {
    if (!decided.limit.granted) throw new SessionLimitDeclinedError();
    step.session = bumpSessionRuntimeUsageLimits(step.session);
  }
  await step.apply(settle(step.view(), { results: [] }));
  return runApproved(step, decided.approved);
}

/**
 * Runs the calls a person approved, each with the tools of the step that asked and as the turn's
 * requester: workflow and agent calls join the runs their steps wait on, and local calls run
 * here, in the step's first attempt. A call that needs a sign-in stops the turn for it.
 */
async function runApproved(
  step: Step,
  approved: readonly ApprovedCall[],
): Promise<StepResult | undefined> {
  if (approved.length === 0) return undefined;
  const responders = new Map(approved.map((call) => [call.request.interactionId, call.responder]));
  const byStep = new Map<SuspendedStep, ApprovedCall["request"][]>();
  for (const { request, step: parked } of approved) {
    byStep.set(parked, [...(byStep.get(parked) ?? []), request]);
  }
  const tasks: RuntimeWorkflowTaskRequest[] = [];
  const denied: ApprovedCallResult[] = [];
  const local: { requests: ApprovedCall["request"][]; tools: HarnessToolLookup }[] = [];
  for (const [parked, requests] of byStep) {
    const tools = toolsOf(step, parked);
    const workflows: ApprovedCall["request"][] = [];
    for (const request of requests) {
      const tool = tools.get(request.call.toolName);
      if (tool?.workflowId === undefined) continue;
      const recheck = await recheckApprovedCall(tool, {
        abortSignal: step.config.abortSignal,
        approvedTools: grantedApprovalKeys(step.view(), (asked) =>
          tools.get(asked.call.toolName)?.approvalKey?.(asked.call.input),
        ),
        callId: request.call.callId,
        input: request.call.input,
      });
      if (recheck.denied) {
        denied.push(
          await rejectApprovedCall({
            position: step.position(),
            publish: step.publish,
            approval: request,
            reason: recheck.reason,
          }),
        );
      } else workflows.push(request);
    }
    local.push({
      requests: requests.filter(
        (request) => tools.get(request.call.toolName)?.workflowId === undefined,
      ),
      tools,
    });
    if (workflows.length === 0) continue;
    const dispatched = collectWorkflowCalls({
      session: step.session,
      toolCalls: workflows.map(({ call }) => ({
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

  const calls = local.flatMap(({ requests }) => requests);
  step.frameworkToolNames = new Set(
    local.flatMap(({ requests, tools }) =>
      requests
        .map((request) => request.call.toolName)
        .filter((name) => tools.get(name)?.frameworkTool === true),
    ),
  );
  if (calls.length === 0) return undefined;
  const position = step.position();
  const attempt = step.instrumentation?.prepareAttempt({
    attemptIndex: 0,
    isFrameworkTool: (name) => step.frameworkToolNames.has(name),
    stepIndex: position.stepIndex,
    turnId: activeTurnId(position),
  });
  const executed = await Promise.all(
    local.map(async ({ requests, tools }) =>
      requests.length === 0
        ? { settled: [], signIns: [] }
        : await runApprovedCalls({
            abortSignal: step.config.abortSignal,
            approvedTools: grantedApprovalKeys(step.view(), (request) =>
              tools.get(request.call.toolName)?.approvalKey?.(request.call.input),
            ),
            approvals: requests,
            messages: step.projectHistory(step.session.history),
            position: step.position(),
            publish: step.publish,
            responderOf: (approval) => responders.get(approval.interactionId),
            telemetry: attempt?.telemetry,
            tools,
          }),
    ),
  );
  await step.apply(settle(step.view(), { results: executed.flatMap((run) => run.settled) }));
  // A cancellation ends the turn once the calls it cut short have their results.
  throwIfTurnAborted(step.config.abortSignal);
  const signIn = resolveInlineAuthorizationInterrupt({
    messages: [],
    signIns: executed.flatMap((run) => run.signIns),
  });
  if (signIn === undefined) return undefined;
  await step.apply(
    requireSignIn(step.view(), {
      callIdsByName: signIn.callIdsByName,
      challenges: signIn.challenges,
    }),
    step.session.history,
  );
  return park(step);
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

/** The entries of the step that asked, restored by building its catalog; the running step's without one. */
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
  await config.participants?.restoreStep({
    at: { sequence: at.sequence, stepIndex: at.stepIndex, turnId: at.turnId },
    messages: step.projectHistory(step.session.history),
    modelId: step.session.agent.modelReference?.id ?? "dynamic",
    parked: parked !== undefined,
  });
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
