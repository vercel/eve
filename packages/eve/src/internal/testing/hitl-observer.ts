import type { ModelMessage, UserContent } from "ai";
import type { SessionAuthContext } from "#channel/types.js";

import type { StepInput } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";

import type { SessionView } from "#harness/session-machine/view.js";

import {
  askedCallIds,
  grantedApprovalKeys,
  heldStep,
  openApprovalsOf,
} from "#harness/hitl/approval.js";
import { candidateAuthorizationAttempts } from "#harness/hitl/approval-candidate.js";
import type { Next } from "#harness/hitl/command.js";
import { pendingTaskToolCalls, type TaskToolCall } from "#execution/tasks/calls.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { SuspendedStep } from "#harness/session-machine/view.js";
import type { RequestAt } from "#harness/hitl/input.js";
import { relayedRequestIds } from "#harness/hitl/relay.js";
import { awaitedAuthorizations } from "#harness/hitl/authorization.js";
import { staleAnswersAsText } from "#harness/hitl/input-stale-answer.js";
/** Read-only scenario assertions over the live SessionView; never reads legacy keys. */
export class HumanInput {
  readonly #state: SessionView;

  readonly #knownRequests?: ReadonlyMap<string, InputRequest>;

  private constructor(state: SessionView, knownRequests?: ReadonlyMap<string, InputRequest>) {
    this.#knownRequests = knownRequests;
    this.#state = state;
  }

  /** Project one originating step. Runtime persistence belongs exclusively to the session machine. */
  static fromView(view: SessionView, stepIndex = 0): HumanInput {
    return new HumanInput(
      {
        ...view,
        turn: {
          ...view.turn,
          suspended:
            view.turn.suspended[stepIndex] === undefined ? [] : [view.turn.suspended[stepIndex]!],
        },
      },
      new Map(
        Object.values(view.projection.inputs).map((entry) => [
          entry.request.requestId,
          entry.request,
        ]),
      ),
    );
  }

  /**
   * What the turn does now: run the calls a person approved (`approvedCalls`),
   * then commit what they did as `actions.settled`; run its next model step;
   * or wait. The model never
   * runs while a request of its own is open, authorizations included; a relayed
   * request waits on the call that asked, not on the model.
   */
  next(): Next {
    if (approvedCallsOf(heldStep(this.#state)) !== undefined) return { run: "approved" };
    return openApprovalsOf(this.#state).length > 0 ||
      this.#state.signIns.some((challenge) => challenge.candidateId === undefined) ||
      Object.values(this.#state.projection.inputs).some(
        (input) => input.status !== "settled" && input.request.kind === "session-limit",
      )
      ? { waiting: "input" }
      : { run: "model" };
  }

  /**
   * The input a step runs with, once answers to closed budget questions are
   * dropped and answers to other requests that are no longer open become text
   * the model reads. `displayMessage` is that input's message as the person
   * sent it, for `message.received`.
   */
  acceptInput(input: StepInput | undefined): {
    readonly input: StepInput | undefined;
    readonly displayMessage?: string | UserContent;
  } {
    const open = this.openRequestIds();
    return staleAnswersAsText(input, open, this.#knownRequests);
  }

  /** Whether turn input waits for the turn's next step, behind calls that have joined history. */
  hasQueuedInput(): boolean {
    return this.#state.turn.queued !== undefined;
  }

  /**
   * The held step's messages: the response of a step whose calls wait,
   * held out of history until each has a result. Tools that run for it read
   * them after history.
   */
  heldMessages(): readonly ModelMessage[] {
    return heldStep(this.#state)?.messages ?? [];
  }

  /**
   * The model step whose calls wait, out of history: each call without a
   * result, tagged with whether it waits on a person or on runtime work.
   */
  heldCalls(): HeldCalls | undefined {
    return heldCalls(heldStep(this.#state), askedCallIds(this.#state));
  }

  /** The held step's calls that run as runtime work and have no result yet. */
  runtimeCalls(): HeldCalls | undefined {
    const held = this.heldCalls();
    return held?.calls.some((call) => call.waitsOn === "runtime") === true ? held : undefined;
  }

  /** The full auth of whoever approved a request, when it was allowed. */
  approverOfRequest(requestId: string): SessionAuthContext | undefined {
    return this.#state.turn.hitl?.audit?.settlements[requestId]?.approver;
  }

  /** The calls a person approved that the turn has yet to run, at the step that asked. */
  approvedCalls():
    | { readonly at: RequestAt; readonly requests: readonly InputRequest[] }
    | undefined {
    return approvedCallsOf(heldStep(this.#state));
  }

  /** Whether the originating live step still holds a transcript. */
  holdsStep(): boolean {
    return heldStep(this.#state) !== undefined;
  }

  /** The approval keys `once()` approvals granted, which approval policies read. */
  grantedApprovalKeys(): ReadonlySet<string> {
    return grantedApprovalKeys(this.#state);
  }

  /** The authorization attempts whose callbacks the turn waits for, its responders' included. */
  awaitedAuthorizations(): readonly string[] {
    return [...awaitedAuthorizations(this.#state), ...candidateAuthorizationAttempts(this.#state)];
  }

  /**
   * Whether the session carries anything for a child or run: a relayed
   * request, or an authorization it started. Ending the run ends what it relayed.
   */
  relaysAnything(): boolean {
    return (
      this.relayedRequestIds().size > 0 ||
      Object.keys(this.#state.turn.hitl?.relayedAuthorizations ?? {}).length > 0
    );
  }

  /**
   * The ids of the open requests of this session's own that an answer can
   * resolve, for routing an answer to its turn. Authorizations are closed by their
   * callbacks instead, and relayed requests belong to whoever asked.
   */
  openRequestIds(): ReadonlySet<string> {
    return new Set([
      ...openApprovalsOf(this.#state).map((open) => open.request.requestId),
      ...Object.values(this.#state.projection.inputs)
        .filter(
          (input) =>
            input.status !== "settled" &&
            input.request.kind === "session-limit" &&
            this.#state.turn.hitl?.relayedRoutes?.[input.request.requestId] === undefined,
        )
        .map((input) => input.request.requestId),
    ]);
  }

  /** Whether the open request is an approval, for attributing its response. */
  isApproval(requestId: string): boolean {
    return openApprovalsOf(this.#state).some((open) => open.request.requestId === requestId);
  }

  /** The ids of the open relayed requests, whose answers a delivery may carry to who asked. */
  relayedRequestIds(): ReadonlySet<string> {
    return relayedRequestIds(this.#state);
  }

  /** How a message from the turn's own person steers the turn now. */
  steering(): Steering {
    return {
      interruptsGeneration: this.relayedRequestIds().size === 0,
      overridesQueue: "waiting" in this.next(),
    };
  }
}

/** How a message from the turn's own person steers the turn. */
export interface Steering {
  /**
   * The turn waits on them, so their message steers it whatever its turn
   * policy: queued, it would wait for a turn that can't end until they act.
   */
  readonly overridesQueue: boolean;
  /**
   * Their message may interrupt the model mid-generation. Not while a request
   * relayed through the session is open: the message may answer it, so it
   * waits for the step boundary that forwards it.
   */
  readonly interruptsGeneration: boolean;
}

/** What a call of the held step waits on: a person's answer, or runtime work. */
export type HeldCallWait = "person" | "runtime";

/**
 * A call of the held step without a result. A call that asked for a
 * authorization is never one: it leaves its step, and the model calls it again.
 */
export interface HeldCall {
  readonly callId: string;
  readonly toolName: string;
  readonly waitsOn: HeldCallWait;
}

/** The held step as the runtime reads it. */
export interface HeldCalls {
  readonly at: RequestAt;
  readonly calls: readonly HeldCall[];
  /** The workflow runs its runtime calls without a result start. */
  readonly tasks: readonly RuntimeWorkflowTaskRequest[];
  readonly approvers?: Readonly<Record<string, SessionAuthContext>>;
  /** Its task tool calls without a result, which the session answers. */
  readonly taskToolCalls: readonly TaskToolCall[];
}

/**
 * Reads the held step: each call that waits, tagged with what it waits
 * on. `asked` names the calls whose approvals are open.
 */
export function heldCalls(
  step: SuspendedStep | undefined,
  asked: ReadonlySet<string>,
): HeldCalls | undefined {
  if (step === undefined) return undefined;
  const answered = answeredCallIds(step.messages);
  const tasks = step.tasks.filter((task) => !answered.has(task.callId));
  const taskToolCalls = step.tasks.length === 0 ? [] : pendingTaskToolCalls(step.messages);
  const unanswered = unansweredCalls(step.messages);
  const toolNames = new Map(unanswered.map((call) => [call.toolCallId, call.toolName]));
  const calls: HeldCall[] = [
    ...tasks.map((task) => ({
      callId: task.callId,
      toolName: task.toolName,
      waitsOn: "runtime" as const,
    })),
    ...taskToolCalls.map((call) => ({
      callId: call.callId,
      toolName: toolNames.get(call.callId) ?? call.kind,
      waitsOn: "runtime" as const,
    })),
  ];
  for (const call of unanswered) {
    if (asked.has(call.toolCallId)) {
      calls.push({ callId: call.toolCallId, toolName: call.toolName, waitsOn: "person" });
    }
  }
  return { at: step.event, calls, taskToolCalls, tasks, approvers: step.approvers };
}

export function unansweredCalls(
  messages: readonly ModelMessage[],
): { readonly toolCallId: string; readonly toolName: string }[] {
  const answered = answeredCallIds(messages);
  const calls: { toolCallId: string; toolName: string }[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type !== "tool-call" || part.providerExecuted === true) continue;
      if (!answered.has(part.toolCallId)) calls.push(part);
    }
  }
  return calls;
}

function answeredCallIds(messages: readonly ModelMessage[]): Set<string> {
  const answered = new Set<string>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-result") answered.add(part.toolCallId);
    }
  }
  return answered;
}

function approvedCallsOf(step: SuspendedStep | undefined) {
  return step?.approved?.length ? { at: step.event, requests: step.approved } : undefined;
}
