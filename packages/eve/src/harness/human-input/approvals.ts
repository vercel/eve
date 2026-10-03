import type { ModelMessage, ToolResultPart } from "ai";

import { resolveTextToResponses } from "#channel/resolve-text.js";
import type { SessionAuthContext } from "#channel/types.js";
import {
  createActionResultEvent,
  createInputRequestedEvent,
  createInputResolvedEvent,
  type InputResolution,
} from "#protocol/message.js";
import type { HarnessToolMap } from "#harness/types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

import type { HumanInputEvent, Interrupt, RequestAt } from "./index.js";
import {
  releaseStep,
  unansweredCalls,
  withMessages,
  withoutCalls,
  withResults,
  type SuspendedStepState,
} from "./suspended-step.js";

// The tool approval rules. A model step's calls open one request each; the
// step's approvals resolve together once each has an answer, or when the turn
// moves past them. Approved calls run in the runtime (`calls.approved`); every
// other call gets a not-run result. The step itself waits out of history and
// joins it only once every call it made has a result.

/** An open approval, as the session stores it. */
export interface OpenApproval {
  readonly kind: "tool-approval";
  readonly at: RequestAt;
  readonly request: InputRequest;
  readonly requester: SessionAuthContext | null;
  /** What a `once()` approval grants: the tool's approval key, else its name. */
  readonly approvalKey: string;
  /** An answer that arrived before the rest of the step's approvals were answered. */
  readonly answer?: InputResponse;
  /** Its tool's `approval.response` policy decides who may answer (see candidates). */
  readonly responsePolicy?: true;
}

/** The state the approval rules read and change. */
interface ApprovalState extends SuspendedStepState {
  readonly requests: Readonly<Record<string, { readonly kind: string }>>;
  readonly grants: readonly string[];
}

interface Reduced<S> {
  readonly events: readonly HumanInputEvent[];
  readonly state: S;
}

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
  /** The step's response, held out of history; see the interrupt's `messages`. */
  readonly messages: readonly ModelMessage[];
  readonly requester: SessionAuthContext | null;
  readonly requests: readonly InputRequest[];
  readonly tools: HarnessToolMap;
}): Extract<Interrupt, { readonly type: "approvals.requested" }> {
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
    type: "approvals.requested",
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
 * step is suspended out of history, and the turn holds.
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
  const requests: Record<string, { readonly kind: string }> = { ...state.requests };
  for (const request of input.requests) {
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
    state: { ...state, requests, suspended: { at: input.at, messages: [...input.messages] } },
  };
}

/**
 * Answers arrived. Each answers its open approval, the last one winning; the
 * step's approvals resolve once every one has an answer. Until then the
 * answers wait in state and the turn stays held.
 */
export function answerApprovals<S extends ApprovalState>(
  state: S,
  responses: readonly InputResponse[],
): Reduced<S> {
  const recorded = recordAnswers(state, responses);
  const open = openApprovalsOf(recorded);
  if (open.length === 0 || open.some((approval) => approval.answer === undefined)) {
    return { events: [], state: recorded };
  }
  return resolveApprovals(recorded);
}

/**
 * A typed reply answers the open approvals whose options it names, and the
 * turn doesn't read it. Approvals a response policy guards are never answered
 * by text: the policy needs to know who answered. Returns `undefined` when the
 * reply answers nothing.
 */
export function answerApprovalsByText<S extends ApprovalState>(
  state: S,
  text: string,
): Reduced<S> | undefined {
  const answerable = openApprovalsOf(state).filter(
    (approval) => approval.answer === undefined && approval.responsePolicy !== true,
  );
  if (answerable.length === 0) return undefined;
  const typed = resolveTextToResponses(
    text,
    answerable.map((approval) => approval.request),
  );
  if (typed.length === 0) return undefined;
  const answered = answerApprovals(state, typed);
  return { ...answered, events: [{ type: "message.answered" }, ...answered.events] };
}

/**
 * A message that answers nothing steers the turn past its approvals: the
 * approvals nobody answered are ignored, and the answers already given stand.
 *
 * Only the turn's own person reaches a held turn with a message; the runtime
 * queues anyone else's for the next turn.
 */
export function steerPastApprovals<S extends ApprovalState>(state: S): Reduced<S> {
  return openApprovalsOf(state).length === 0 ? { events: [], state } : resolveApprovals(state);
}

/** Whether a response policy decides who may answer this open approval. */
export function isPolicyGated(state: ApprovalState, requestId: string): boolean {
  const open = state.requests[requestId];
  return isOpenApproval(open) && open.responsePolicy === true;
}

/**
 * The turn was cancelled: every open approval is cancelled, and its call never
 * runs. The suspended step joins history with a not-run result for each call
 * still without one.
 */
export function cancelApprovals<S extends ApprovalState>(state: S): Reduced<S> {
  const open = openApprovalsOf(state);
  if (open.length === 0 && state.suspended === undefined) return { events: [], state };
  const events: HumanInputEvent[] = open.map((approval) =>
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
  const cancelled = open.map((approval) => notRunPart(approval, "cancelled"));
  const approvalCallIds = new Set(open.map((approval) => approval.request.action.callId));
  for (const call of unansweredCalls(state.suspended?.messages ?? [])) {
    if (approvalCallIds.has(call.toolCallId)) continue;
    cancelled.push({
      output: { reason: NOT_RUN_REASONS.cancelled, type: "execution-denied" },
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      type: "tool-result",
    });
  }
  const released = releaseStep({ ...state, requests: withoutApprovals(state.requests) }, cancelled);
  return { events: [...events, ...released.events], state: released.state };
}

/**
 * Calls of the suspended step settled: approved calls eve ran, or runtime
 * calls that ran beside open approvals. Their results join the step. Once no
 * approval is open, the step joins history and the turn goes on, unless some
 * approved calls still run as runtime work (`running`): then the step goes
 * with them (`calls.dispatched`) and joins history with their results.
 */
export function settleCalls<S extends ApprovalState>(
  state: S,
  results: readonly ModelMessage[],
  running: readonly string[] = [],
  stopped: readonly string[] = [],
): Reduced<S> {
  const { suspended } = state;
  // A step parked before steps were held out of history has its calls there.
  if (suspended === undefined) {
    return { events: results.map((message) => ({ message, type: "history.appended" })), state };
  }
  const joined = withMessages(suspended.messages, results);
  // Calls that asked for a sign-in leave the step; the model calls them again.
  const messages = stopped.length === 0 ? joined : withoutCalls(joined, new Set(stopped));
  const settled = { ...state, suspended: { ...suspended, messages } };
  if (openApprovalsOf(state).length > 0) return { events: [], state: settled };
  if (running.length === 0) return releaseStep(settled, []);
  const { suspended: _dispatched, ...rest } = settled;
  return {
    events: [{ at: suspended.at, messages, type: "calls.dispatched" }],
    state: rest as unknown as S,
  };
}

/**
 * The approval keys `once()` approvals granted, for approval policies to read.
 * A grant is hidden while an approval for its key still waits, so the policy
 * keeps asking for that call.
 */
export function grantedApprovalKeys(state: ApprovalState): ReadonlySet<string> {
  const waiting = new Set(openApprovalsOf(state).map((approval) => approval.approvalKey));
  return new Set(state.grants.filter((key) => !waiting.has(key)));
}

/**
 * Resolves the step's approvals together: one `input.resolved` at the asking
 * step, a not-run result and a rejected `action.result` for each call that
 * won't run, and `calls.approved` for the rest. An approval nobody answered
 * is ignored.
 */
function resolveApprovals<S extends ApprovalState>(state: S): Reduced<S> {
  const open = openApprovalsOf(state);
  const resolutions: InputResolution[] = [];
  const notRun: ToolResultPart[] = [];
  const rejected: HumanInputEvent[] = [];
  const approved: InputRequest[] = [];
  const grants = new Set(state.grants);
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
  const events: HumanInputEvent[] = [
    publish(createInputResolvedEvent({ ...at, resolutions })),
    ...rejected,
  ];
  const resolved = { ...state, grants: [...grants], requests: withoutApprovals(state.requests) };
  if (approved.length === 0) {
    const released = releaseStep(resolved, notRun);
    return { events: [...events, ...released.events], state: released.state };
  }
  // The step waits for the approved calls' results; see `settleCalls`.
  const suspended =
    resolved.suspended === undefined
      ? undefined
      : { ...resolved.suspended, messages: withResults(resolved.suspended.messages, notRun) };
  if (suspended === undefined && notRun.length > 0) {
    events.push({ message: notRunMessage(notRun), type: "history.appended" });
  }
  events.push({ at, requests: approved, type: "calls.approved" });
  return { events, state: suspended === undefined ? resolved : { ...resolved, suspended } };
}

function outcomeOf(answer: InputResponse | undefined): Outcome {
  if (answer === undefined) return "ignored";
  if (answer.optionId === "approve") return "approved";
  // ACP answers with "deny"; eve's own approval prompts offer "cancel".
  if (answer.optionId === "cancel" || answer.optionId === "deny") return "denied";
  return "invalid";
}

function recordAnswers<S extends ApprovalState>(state: S, responses: readonly InputResponse[]): S {
  const requests: Record<string, { readonly kind: string }> = { ...state.requests };
  for (const response of responses) {
    const open = requests[response.requestId];
    if (!isOpenApproval(open)) continue;
    const answered: OpenApproval = { ...open, answer: response };
    requests[response.requestId] = answered;
  }
  return { ...state, requests };
}

function openApprovalsOf(state: ApprovalState): OpenApproval[] {
  return Object.values(state.requests).filter(isOpenApproval);
}

function isOpenApproval(value: { readonly kind: string } | undefined): value is OpenApproval {
  return value?.kind === "tool-approval";
}

function withoutApprovals<R extends { readonly kind: string }>(
  requests: Readonly<Record<string, R>>,
): Readonly<Record<string, R>> {
  return Object.fromEntries(
    Object.entries(requests).filter(([, request]) => !isOpenApproval(request)),
  );
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

function publish(event: Extract<HumanInputEvent, { type: "publish" }>["event"]): HumanInputEvent {
  return { event, type: "publish" };
}
