import { withResult } from "#harness/session-machine/transitions.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import type { ModelMessage, ToolResultPart } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import {
  createActionResultEvent,
  createApprovalSettledEvent,
  createInputRequestedEvent,
  createInputResolvedEvent,
  createMessageCompletedEvent,
  type InputResolution,
} from "#protocol/message.js";
import type { HarnessToolMap } from "#harness/types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

import type { Command } from "./command.js";
import type { Input, RequestAt } from "./input.js";
import { EMPTY_AUDIT, type Reduced, type OpenApproval } from "./state.js";
import type { SessionView, SuspendedStep } from "#harness/session-machine/view.js";
import { hitlStepKey } from "./record.js";

// The tool approval rules. A model step's calls open one request each; the
// step's approvals resolve together once each has an answer, or when the turn
// moves past them. The host runs the approved calls (`next()` is
// `{ run: "approved" }`); every other call gets a not-run result. The step is
// held out of history and settles once every call it made has a result.

/** The state the approval rules read and change. */
type ApprovalState = SessionView;

type Outcome = "approved" | "denied" | "invalid" | "ignored";

const NOT_RUN_REASONS: Record<Exclude<Outcome, "approved"> | "cancelled", string> = {
  cancelled: "Cancelled before anyone answered.",
  denied: "Tool execution was denied.",
  ignored: "Ignored because the user continued without responding.",
  invalid: "Invalid approval response.",
};

/**
 * What a model step's approval requests ask, read from the tools that made
 * them: the key a `once()` approval grants, and whether a response policy
 * decides who may answer.
 */
export function approvalsRequested(input: {
  readonly at: RequestAt;
  /** The step's response, held out of history until every call it made has a result. */
  readonly messages: readonly ModelMessage[];
  readonly requester: SessionAuthContext | null;
  readonly requests: readonly InputRequest[];
  readonly tools: HarnessToolMap;
}): Extract<Input, { readonly type: "approval.requested" }> {
  const approvalKeys: Record<string, string> = {};
  const responsePolicyRequestIds: string[] = [];
  for (const request of input.requests) {
    const tool = input.tools.get(request.action.toolName);
    if (tool?.approvalKey !== undefined) {
      approvalKeys[request.requestId] = tool.approvalKey(request.action.input);
    }
    const approval = tool?.approval;
    if (
      approval !== undefined &&
      typeof approval !== "function" &&
      approval.response !== undefined
    ) {
      responsePolicyRequestIds.push(request.requestId);
    }
  }
  return {
    approvalKeys,
    at: input.at,
    messages: input.messages,
    requester: input.requester,
    requests: input.requests,
    responsePolicyRequestIds,
    type: "approval.requested",
  };
}

/**
 * Drops the AI SDK's approval request and response parts, and messages they
 * leave empty: eve answers approvals itself, so they never reach history.
 */
export function withoutApprovalParts(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    if (message.role === "assistant" && typeof message.content !== "string") {
      const content = message.content.filter((part) => part.type !== "tool-approval-request");
      if (content.length === message.content.length) return [message];
      return content.length === 0 ? [] : [{ ...message, content }];
    }
    if (message.role === "tool") {
      const content = message.content.filter((part) => part.type !== "tool-approval-response");
      if (content.length === message.content.length) return [message];
      return content.length === 0 ? [] : [{ ...message, content }];
    }
    return [message];
  });
}

/**
 * A model step's calls ask for approval: each becomes an open request, the
 * step is held out of history, and the turn waits. A request id already open,
 * or repeated among them, throws before anything is published: it would
 * replace a call the turn still tracks.
 */
export function openApprovals<S extends ApprovalState>(
  state: S,
  input: {
    readonly at: RequestAt;
    readonly messages: readonly ModelMessage[];
    readonly requests: readonly InputRequest[];
    readonly requester: SessionAuthContext | null;
    readonly approvalKeys: Readonly<Record<string, string>>;
    readonly responsePolicyRequestIds: readonly string[];
  },
): Reduced<S> {
  // Every anonymous caller shares one identity, so an anonymous requester
  // can't be told apart from another anonymous person: record none.
  const requester = input.requester?.principalType === "anonymous" ? null : input.requester;
  const requests: Record<string, OpenApproval> = Object.fromEntries(
    openApprovalsOf(state).map((open) => [open.request.requestId, open]),
  );
  for (const request of input.requests) {
    if (request.requestId in requests) {
      throw new TypeError(`Duplicate input request id: ${JSON.stringify(request.requestId)}.`);
    }
    const approval: OpenApproval = {
      approvalKey: input.approvalKeys[request.requestId] ?? request.action.toolName,
      at: input.at,
      kind: "tool-approval",
      request,
      requester,
      ...(input.responsePolicyRequestIds.includes(request.requestId) && {
        responsePolicy: true as const,
      }),
    };
    requests[request.requestId] = approval;
  }
  return {
    events: [publish(createInputRequestedEvent({ ...input.at, requests: input.requests }))],
    state: withOpenApprovals(state, Object.values(requests)),
  };
}

/**
 * Answers arrived. Each answers its open approval, the last one winning; the
 * step's approvals resolve once every one has an answer. Until then the
 * answers wait in state and the turn keeps waiting.
 *
 * An Approve or Cancel from a signed-in `responder` settles its approval the
 * moment it arrives (`approval.settled`, naming who answered), ahead of the
 * step's `input.resolved`, so a channel can retire the card with the
 * responder's name. Approvals a response policy gates settle through their
 * candidates instead, and never reach this with a responder.
 */
export function answerApprovals<S extends ApprovalState>(
  state: S,
  responses: readonly InputResponse[],
  responder: SessionAuthContext | null = null,
): Reduced<S> {
  const feedback: Command[] = [];
  const accepted = responses.filter((response) => {
    const approval = approvalOf(state, response.requestId);
    const outcome = outcomeOf(response);
    if (
      isOpenApproval(approval) &&
      approval.responsePolicy !== true &&
      responder !== null &&
      (outcome === "approved" || outcome === "denied") &&
      approval.requester !== null &&
      !sameResponder(approval.requester, responder)
    ) {
      // Consume the response, but leave the request open. Only a response policy
      // opts an authenticated requester's approval into other responders.
      feedback.push(
        publish(
          createMessageCompletedEvent({
            ...approval.at,
            message: "Only the person who requested this action can respond to this approval.",
          }),
        ),
      );
      return false;
    }
    return true;
  });
  const settled =
    responder === null ? { events: [], state } : settledBy(state, accepted, responder);
  const recorded = recordAnswers(settled.state, accepted);
  const open = openApprovalsOf(recorded);
  if (open.length === 0 || open.some((approval) => approval.answer === undefined)) {
    return { events: [...feedback, ...settled.events], state: recorded };
  }
  const resolved = resolveApprovals(recorded);
  return { events: [...feedback, ...settled.events, ...resolved.events], state: resolved.state };
}

/**
 * An approval the audit already settled, but whose answer never reached its step: a checkpoint
 * saved between the two. The recorded outcome stands, as its synthetic answer; the response
 * policy and the requester check already ran, and the settlement keeps who approved.
 */
export function applyRecordedSettlements<S extends ApprovalState>(state: S): Reduced<S> {
  const settlements = state.turn.hitl?.audit?.settlements ?? {};
  const responses: InputResponse[] = [];
  for (const [requestId, open] of openApprovalsOf(state).map(
    (open) => [open.request.requestId, open] as const,
  )) {
    if (!isOpenApproval(open) || open.answer !== undefined) continue;
    const settlement = settlements[requestId];
    if (settlement === undefined) continue;
    responses.push({
      optionId: settlement.outcome === "allowed" ? "approve" : "cancel",
      requestId,
    });
  }
  return responses.length === 0 ? { events: [], state } : answerApprovals(state, responses);
}

/**
 * Settles each approval `responder` decided: the audit records who, and the
 * event names them.
 */
function settledBy<S extends ApprovalState>(
  state: S,
  responses: readonly InputResponse[],
  responder: SessionAuthContext,
): Reduced<S> {
  const events: Command[] = [];
  const settlements = { ...state.turn.hitl?.audit?.settlements };
  for (const response of responses) {
    const approval = approvalOf(state, response.requestId);
    const outcome = outcomeOf(response);
    if (!isOpenApproval(approval) || (outcome !== "approved" && outcome !== "denied")) continue;
    settlements[response.requestId] = {
      actor: {
        authenticator: responder.authenticator,
        ...(responder.issuer !== undefined && { issuer: responder.issuer }),
        principalId: responder.principalId,
        principalType: responder.principalType,
      },
      ...(outcome === "approved" && { approver: responder }),
      outcome: outcome === "approved" ? "allowed" : "cancelled",
      requestId: response.requestId,
    };
    events.push(
      publish(
        createApprovalSettledEvent({
          ...approval.at,
          outcome: outcome === "approved" ? "approved" : "cancelled",
          requestId: response.requestId,
          responderPrincipalId: responder.principalId,
        }),
      ),
    );
  }
  if (events.length === 0) return { events, state };
  const audit = state.turn.hitl?.audit ?? EMPTY_AUDIT;
  return {
    events,
    state: {
      ...state,
      turn: { ...state.turn, hitl: { ...state.turn.hitl, audit: { ...audit, settlements } } },
    },
  };
}

/**
 * A message that answers nothing steers the turn past its approvals: the
 * approvals nobody answered are ignored, and the answers already given stand.
 *
 * Only the turn's own person reaches a waiting turn with a message; the runtime
 * queues anyone else's for the next turn.
 */
export function steerPastApprovals<S extends ApprovalState>(state: S): Reduced<S> {
  return openApprovalsOf(state).length === 0 ? { events: [], state } : resolveApprovals(state);
}

/** Whether a response policy decides who may answer this open approval. */
export function isPolicyGated(state: ApprovalState, requestId: string): boolean {
  const open = approvalOf(state, requestId);
  return isOpenApproval(open) && open.responsePolicy === true;
}

/**
 * The turn was cancelled: every open approval is cancelled, and its call never
 * runs. Its not-run result joins the held step as the step is cancelled
 * (see `cancelStep`), or history directly for a step parked before steps were
 * held out of history, whose calls are already there.
 */
export function cancelApprovals<S extends ApprovalState>(state: S): Reduced<S> {
  const open = openApprovalsOf(state);
  if (open.length === 0) return { events: [], state };
  const events: Command[] = open.map((approval) =>
    publish(
      createInputResolvedEvent({
        ...approval.at,
        resolutions: [
          {
            kind: approval.request.kind,
            outcome: "cancelled",
            requestId: approval.request.requestId,
          },
        ],
      }),
    ),
  );
  if (heldStep(state) === undefined) {
    events.push({
      message: notRunMessage(open.map((approval) => notRunPart(approval, "cancelled"))),
      type: "appendHistory",
    });
  }
  return { events, state: withOpenApprovals(state, []) };
}

/** The calls whose approvals are open, which wait on a person. */
export function askedCallIds(state: ApprovalState): ReadonlySet<string> {
  return new Set(openApprovalsOf(state).map((approval) => approval.request.action.callId));
}

/**
 * The approval keys `once()` approvals granted, for approval policies to read.
 * A grant is hidden while an approval for its key still waits, so the policy
 * keeps asking for that call.
 */
export function grantedApprovalKeys(
  state: ApprovalState,
  approvalKey?: (request: InputRequest) => string | undefined,
): ReadonlySet<string> {
  const waiting = new Set(
    openApprovalsOf(state).map(
      (approval) => approvalKey?.(approval.request) ?? approval.approvalKey,
    ),
  );
  return new Set(state.turn.grants.filter((key) => !waiting.has(key)));
}

/**
 * Resolves the step's approvals together: one `input.resolved` at the asking
 * step, a not-run result and a rejected `action.result` for each call that
 * won't run; the rest wait on the held step for the turn to run them.
 * An approval nobody answered is ignored.
 */
function resolveApprovals<S extends ApprovalState>(state: S): Reduced<S> {
  const open = openApprovalsOf(state);
  const resolutions: InputResolution[] = [];
  const notRun: ToolResultPart[] = [];
  const rejected: Command[] = [];
  const approved: InputRequest[] = [];
  const grants = new Set(state.turn.grants);
  for (const approval of open) {
    const outcome = outcomeOf(approval.answer);
    resolutions.push({
      kind: approval.request.kind,
      outcome,
      requestId: approval.request.requestId,
      ...(approval.answer !== undefined && { response: approval.answer }),
    });
    if (outcome === "approved") {
      approved.push(approval.request);
      grants.add(approval.approvalKey);
      continue;
    }
    notRun.push(notRunPart(approval, outcome));
    rejected.push(
      publish(
        createActionResultEvent({
          ...approval.at,
          rejected: true,
          result: {
            callId: approval.request.action.callId,
            isError: true,
            kind: "tool-result",
            output: {
              approval: { requestId: approval.request.requestId, status: outcome },
              code: "TOOL_EXECUTION_DENIED",
              message: NOT_RUN_REASONS[outcome],
              tool: { result: "not_run" },
            },
            toolName: approval.request.action.toolName,
          },
        }),
      ),
    );
  }
  // At most one step has open approvals, so they share its coordinates.
  const at = open[0]!.at;
  const events: Command[] = [
    publish(createInputResolvedEvent({ ...at, resolutions })),
    ...rejected,
  ];
  const closed = withOpenApprovals(state, []);
  const resolved = { ...closed, turn: { ...closed.turn, grants: [...grants] } };
  if (approved.length === 0) {
    if (heldStep(resolved) === undefined)
      return {
        events: [...events, { type: "appendHistory", message: notRunMessage(notRun) }],
        state: resolved,
      };
    return {
      events,
      state: withHeldStep(resolved, {
        ...heldStep(resolved)!,
        messages: notRun.reduce<ModelMessage[]>(
          (messages, part) => withResult(messages, part),
          [...heldStep(resolved)!.messages],
        ),
      }),
    };
  }
  // The host runs the approved calls (`approvedCalls`); the step stays held
  // until their results settle it. A step parked before
  // steps were held out of history has its calls there: it holds only the
  // results, which join history after them.
  const step = heldStep(resolved) ?? { event: at, messages: [], requests: [], tasks: [] };
  const held = {
    ...step,
    approved,
    messages: notRun.reduce<ModelMessage[]>(
      (messages, part) => withResult(messages, part),
      [...step.messages],
    ),
  };
  return { events, state: withHeldStep(resolved, held) };
}

/** An approval's outcome from its answer; a relayed approval resolves the same way. */
export function outcomeOf(answer: InputResponse | undefined): Outcome {
  if (answer === undefined) return "ignored";
  if (answer.optionId === "approve") return "approved";
  // ACP answers with "deny"; eve's own approval prompts offer "cancel".
  if (answer.optionId === "cancel" || answer.optionId === "deny") return "denied";
  return "invalid";
}

function recordAnswers<S extends ApprovalState>(state: S, responses: readonly InputResponse[]): S {
  const requests: Record<string, OpenApproval> = Object.fromEntries(
    openApprovalsOf(state).map((open) => [open.request.requestId, open]),
  );
  for (const response of responses) {
    const open = requests[response.requestId];
    if (!isOpenApproval(open)) continue;
    const answered: OpenApproval = { ...open, answer: response };
    requests[response.requestId] = answered;
  }
  return withOpenApprovals(state, Object.values(requests));
}

export function openApprovalsOf(state: SessionView): OpenApproval[] {
  return state.turn.suspended.flatMap((step) => {
    const record = state.turn.hitl?.steps?.[hitlStepKey(step.event)];
    return step.requests.map((request) => ({
      kind: "tool-approval" as const,
      at: step.event,
      request,
      requester: step.requester ?? null,
      approvalKey: record?.approvalKeys[request.requestId] ?? request.action.toolName,
      ...(record?.answers[request.requestId] !== undefined && {
        answer: record.answers[request.requestId],
      }),
      ...(step.responseAuthRequiredRequestIds?.includes(request.requestId) && {
        responsePolicy: true as const,
      }),
    }));
  });
}

export function approvalOf(view: SessionView, requestId: string): OpenApproval | undefined {
  return openApprovalsOf(view).find((open) => open.request.requestId === requestId);
}

export function heldStep(view: SessionView): SuspendedStep | undefined {
  const step = view.turn.suspended[0];
  return step?.transcriptCommitted === true &&
    step.tasks.length === 0 &&
    step.approved === undefined
    ? undefined
    : step;
}

export function withHeldStep<S extends SessionView>(view: S, step: SuspendedStep): S {
  return { ...view, turn: { ...view.turn, suspended: [step] } };
}

function withOpenApprovals<S extends SessionView>(view: S, approvals: readonly OpenApproval[]): S {
  const step = view.turn.suspended[0];
  if (step === undefined) return view;
  const steps = { ...view.turn.hitl?.steps };
  const key = hitlStepKey(step.event);
  if (approvals.length === 0) delete steps[key];
  else
    steps[key] = {
      approvalKeys: Object.fromEntries(
        approvals.map((open) => [open.request.requestId, open.approvalKey]),
      ),
      answers: Object.fromEntries(
        approvals.flatMap((open) =>
          open.answer === undefined ? [] : [[open.request.requestId, open.answer]],
        ),
      ),
    };
  return {
    ...view,
    turn: {
      ...view.turn,
      hitl: { ...view.turn.hitl, steps },
      suspended: [
        {
          ...step,
          requests: approvals.map((open) => open.request),
          requester: approvals[0]?.requester ?? step.requester,
          responseAuthRequiredRequestIds: approvals
            .filter((open) => open.responsePolicy)
            .map((open) => open.request.requestId),
        },
      ],
    },
  };
}

function isOpenApproval(value: { readonly kind: string } | undefined): value is OpenApproval {
  return value?.kind === "tool-approval";
}

function notRunPart(approval: OpenApproval, outcome: keyof typeof NOT_RUN_REASONS): ToolResultPart {
  return {
    output: { reason: NOT_RUN_REASONS[outcome], type: "execution-denied" },
    toolCallId: approval.request.action.callId,
    toolName: approval.request.action.toolName,
    type: "tool-result",
  };
}

function notRunMessage(parts: readonly ToolResultPart[]): ModelMessage {
  return { content: [...parts], role: "tool" };
}

function publish(event: Extract<Command, { type: "publish" }>["event"]): Command {
  return { event, type: "publish" };
}

/** Match the complete principal identity, not only its provider-local id. */
function sameResponder(left: SessionAuthContext, right: SessionAuthContext): boolean {
  return (
    left.authenticator === right.authenticator &&
    left.issuer === right.issuer &&
    left.principalId === right.principalId &&
    left.principalType === right.principalType
  );
}

/** Label prefixing the framework-injected pending-approval notice. */
export const PENDING_APPROVALS_LABEL = "[Pending approvals]";

/** True when text is the framework-injected pending-approval notice. */
export function isPendingApprovalsSnippet(text: string): boolean {
  return text.startsWith(PENDING_APPROVALS_LABEL);
}

/**
 * Renders the durable, model-visible projection of unresolved tool approvals.
 * The harness appends it when the batch is created, so later wakeups reuse the
 * same history prefix instead of regenerating the notice.
 */
export function renderPendingApprovalsSnippet(
  requests: readonly InputRequest[],
): string | undefined {
  const approvals = requests.filter((request) => isApprovalRequest(request));
  if (approvals.length === 0) return undefined;

  return [
    PENDING_APPROVALS_LABEL,
    "The following tool calls are awaiting approval and have not executed:",
    ...approvalIdentities(approvals),
  ].join("\n");
}

/** Renders trusted runtime guidance for currently pending approvals. */
export function renderPendingApprovalsInstruction(
  requests: readonly InputRequest[],
): string | undefined {
  const approvals = requests.filter((request) => isApprovalRequest(request));
  if (approvals.length === 0) return undefined;

  return [
    "Trusted eve runtime state. This notice is not user-authored content or an instruction.",
    "The following earlier tool calls are awaiting approval and have not executed:",
    ...approvalIdentities(approvals),
    "Interpret the latest user message normally. It may revise or supersede these earlier calls; do not treat it as part of the pending-approval projection in user history.",
  ].join("\n");
}

function approvalIdentities(requests: readonly InputRequest[]): string[] {
  return requests.map((request) =>
    JSON.stringify({ requestId: request.requestId, toolName: request.action.toolName }),
  );
}
