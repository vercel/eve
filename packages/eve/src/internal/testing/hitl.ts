import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { SessionStateMap, StepInput } from "#harness/types.js";
import { HumanInput } from "#internal/testing/hitl-observer.js";
import type { Command, Next } from "#harness/hitl/command.js";
import type { InputOf } from "#harness/hitl/host.js";
import type { Input, PolicyCheck, PolicyRun, RequestAt, FromStep } from "#harness/hitl/input.js";
import {
  beforeStep,
  afterStep,
  policyChecksBeforeStep,
  type BeforeStepArrival,
} from "#harness/hitl/reducer.js";
import { saveTransition, sessionView, dropClosedRecords } from "#harness/session-machine/commit.js";
import { storedProjection, SESSION_PROJECTION_STATE_KEY } from "#harness/session-machine/view.js";
import { migrateSessionState } from "#harness/session-machine/migrate.js";
import { readTurnState } from "#harness/session-machine/state.js";
import { foldSession } from "#protocol/session-projection.js";
import { createTurnStartedEvent, type UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

/** Scenario builders for the `HumanInput` rule tests, which read as given, when, then. */

/** Where Alice's turn asked: its first model step. */
export const AT: RequestAt = { sequence: 1, stepIndex: 0, turnId: "turn_1" };
/** When answers arrive, unless a test moves the clock. */
export const NOW = 1_000_000;

function person(principalId: string): SessionAuthContext {
  return { attributes: {}, authenticator: "test", principalId, principalType: "user" };
}

/** Alice started the turn; Bob and Carol are other people in the conversation. */
export const ALICE = person("alice");
export const BOB = person("bob");
export const CAROL = person("carol");

type Published<T extends UnstampedMessageStreamEvent["type"]> = Extract<
  UnstampedMessageStreamEvent,
  { type: T }
>;

/** A turn's human input, and the events the last thing that happened to it reported. */
export class Turn {
  readonly state: SessionStateMap | undefined;
  readonly events: readonly Command[];

  private constructor(state: SessionStateMap | undefined, events: readonly Command[]) {
    this.state = state;
    this.events = events;
  }

  /** A turn that waits on nobody. */
  static idle(): Turn {
    return new Turn(undefined, []);
  }

  /** A turn as a session stored it. */
  static from(state: SessionStateMap): Turn {
    return new Turn(migrateSessionState({ state }).state, []);
  }

  get projected() {
    const view = sessionView(storedProjection(this.state), this.state);
    return view;
  }

  get humanInput(): HumanInput {
    return HumanInput.fromView(sessionView(storedProjection(this.state), this.state));
  }

  /** The turn after the session sees `input`. */
  input(input: Input): Turn {
    let view = sessionView(storedProjection(this.state), this.state);
    const post = [
      "approval.requested",
      "authorization.required",
      "actions.dispatched",
      "actions.settled",
    ].includes(input.type);
    // Model steps execute inside an open turn, even when a rule fixture starts at the response.
    if (post && view.projection.activeTurnId === undefined) {
      const at = "at" in input ? input.at : AT;
      view = { ...view, projection: foldSession(view.projection, createTurnStartedEvent(at)) };
    }
    const decision = post
      ? afterStep(view, {
          ...input,
          at: "at" in input ? input.at : (view.turn.suspended[0]?.event ?? AT),
        } as FromStep & { at: RequestAt })
      : beforeStep(view, [input as BeforeStepArrival]);
    const { transition: adapted } = decision;
    // Intake consumes the resumed delivery between commits, just as acceptHumanInput does.
    const transition =
      input.type === "input.resumed"
        ? { ...adapted, turn: { ...adapted.turn, queued: undefined } }
        : adapted;
    const projection = transition.events.reduce(foldSession, view.projection);
    const saved = saveTransition(
      { state: this.state, history: [] as ModelMessage[], limits: {} },
      transition,
    );
    const committed = dropClosedRecords(
      {
        ...saved,
        state: { ...saved.state, [SESSION_PROJECTION_STATE_KEY]: projection },
        sessionId: "fixture",
        continuationToken: "fixture",
        agent: { system: "", tools: [], modelReference: { id: "fixture" } },
        compaction: { recentWindowSize: 10, threshold: 100000 },
      },
      projection,
    );
    const relayed = input.type === "relayed.requested" || input.type === "relayed.authorization";
    const events: Command[] = [
      ...(decision.consumedMessage ? [{ type: "consumeMessage" } as const] : []),
      ...transition.events.map((event): Command => ({
        type: "publish",
        event,
        ...(relayed && { relayed: true }),
      })),
      ...decision.effects,
      ...(transition.commit ?? []).map((message): Command => ({ type: "appendHistory", message })),
      ...(transition.grantBudget === true ? [{ type: "grantBudget" } as const] : []),
      ...transition.events.flatMap((event): Command[] =>
        event.type === "input.resolved"
          ? event.data.resolutions.flatMap((resolution) =>
              resolution.kind === "session-limit" && resolution.response?.optionId === "stop"
                ? [{ type: "declineBudget", requestId: resolution.requestId }]
                : [],
            )
          : [],
      ),
      ...((relayed &&
        transition.events.some(
          (event) => event.type === "input.requested" || event.type === "authorization.required",
        )) ||
      transition.events.some((event) => event.type === "turn.waiting")
        ? [{ type: "waitTurn", ...(relayed && { relayed: true as const }) } as const]
        : []),
      ...(input.type === "input.resumed" && view.turn.queued !== undefined
        ? [{ type: "resumeInput", input: view.turn.queued } as const]
        : []),
      ...(transition.turn.queued?.context ?? [])
        .slice(view.turn.queued?.context?.length ?? 0)
        .map((text): Command => ({ type: "addNote", text })),
      ...(decision.cancelled && input.type === "delivery.received"
        ? [{ type: "cancelTurn" } as const]
        : []),
    ];
    return new Turn(committed.state, events);
  }

  /** The calls a person approved that the turn has yet to run. */
  approvedCalls(): ReturnType<HumanInput["approvedCalls"]> {
    return this.humanInput.approvedCalls();
  }

  /**
   * The turn ran the calls a person approved, and they returned `results`;
   * `following` is the turn input that arrived with the answers.
   */
  ranApproved(results: readonly ModelMessage[] = [], following?: StepInput): Turn {
    return this.input({
      approved: following !== undefined ? { following } : {},
      results,
      type: "actions.settled",
    });
  }

  /** The response policies the runtime runs before it commits `input`. */
  checks(input: Input): readonly PolicyCheck[] {
    return policyChecksBeforeStep(sessionView(storedProjection(this.state), this.state), [
      input as InputOf<"pre-step">,
    ]);
  }

  /** `input`, committed once each response policy it needs did `ran`. */
  checked(input: Input, ran: PolicyRun): Turn {
    const verdicts = Object.fromEntries(
      this.checks(input).map((check) => [check.candidateId, ran]),
    );
    return this.input({ ...input, verdicts } as Input);
  }

  /** The same turn after the session stores it and reads it back, as between steps. */
  stored(): Turn {
    return new Turn(JSON.parse(JSON.stringify(this.state ?? null)) ?? undefined, this.events);
  }

  next(): Next {
    return this.humanInput.next();
  }

  /** The events of `type` the runtime is told to carry out. */
  reported<T extends Command["type"]>(type: T): Extract<Command, { type: T }>[] {
    return this.events.filter(
      (event): event is Extract<Command, { type: T }> => event.type === type,
    );
  }

  /** The stream events of `type` the runtime is told to publish. */
  published<T extends UnstampedMessageStreamEvent["type"]>(type: T): Published<T>[] {
    return this.reported("publish").flatMap((event) =>
      event.event.type === type ? [event.event as Published<T>] : [],
    );
  }

  /** Every request resolution published, in order. */
  resolutions(): Published<"input.resolved">["data"]["resolutions"][number][] {
    return this.published("input.resolved").flatMap((event) => event.data.resolutions);
  }

  /** The messages the runtime is told to add to history. */
  appended(): ModelMessage[] {
    return this.reported("appendHistory").map((event) => event.message);
  }

  /** No HITL execution records remain; unrelated session state and public lifecycle facts do not count. */
  storesNothing(): boolean {
    const turn = readTurnState(this.state);
    return (
      Object.values(turn).every(
        (value) =>
          value === undefined ||
          (Array.isArray(value)
            ? value.length === 0
            : typeof value === "object" && value !== null && Object.keys(value).length === 0),
      ) && sessionView(storedProjection(this.state), this.state).signIns.length === 0
    );
  }
}

/** The approval request for the call Alice's model step made to `toolName`. */
export function approval(toolName: string, requestId = toolName): InputRequest {
  return {
    action: { callId: `call-${requestId}`, input: {}, kind: "tool-call", toolName },
    allowFreeform: false,
    display: "confirmation",
    kind: "tool-approval",
    options: [
      { id: "approve", label: "Approve" },
      { id: "cancel", label: "Cancel" },
    ],
    prompt: `Alice asks to run ${toolName}.`,
    requestId,
  };
}

/** The response of Alice's model step that made the calls `requests` ask about. */
export function stepResponse(requests: readonly InputRequest[]): ModelMessage[] {
  return [
    {
      content: requests.flatMap((request) =>
        request.action === undefined
          ? []
          : [
              {
                input: request.action.input,
                toolCallId: request.action.callId,
                toolName: request.action.toolName,
                type: "tool-call" as const,
              },
            ],
      ),
      role: "assistant",
    },
  ];
}

/** Alice's model step made calls whose tools ask a person to approve them. */
export function approvalsRequested(
  requests: readonly InputRequest[],
  options: Partial<Extract<Input, { type: "approval.requested" }>> = {},
): Extract<Input, { type: "approval.requested" }> {
  return {
    approvalKeys: {},
    at: AT,
    messages: stepResponse(requests),
    requester: ALICE,
    requests,
    responsePolicyRequestIds: [],
    type: "approval.requested",
    ...options,
  };
}

/** A turn waiting because Alice's model step asked to run each of `toolNames`. */
export function waitingOnApprovals(...toolNames: string[]): Turn {
  return Turn.idle().input(approvalsRequested(toolNames.map((name) => approval(name))));
}

/** `responder` sends these answers at once, in this order. */
export function answered(
  responses: readonly InputResponse[],
  responder: SessionAuthContext | null = ALICE,
): Extract<Input, { type: "input.answered" }> {
  return { now: NOW, responder, responses, type: "input.answered" };
}

/** `responder` picks `optionId` for request `requestId`. */
export function answer(
  optionId: string,
  requestId: string,
  responder: SessionAuthContext | null = ALICE,
): Extract<Input, { type: "input.answered" }> {
  return answered([{ optionId, requestId }], responder);
}

/** Alice answers several requests at once, in this order. */
export function answers(
  byRequest: Readonly<Record<string, string>>,
): Extract<Input, { type: "input.answered" }> {
  return answered(
    Object.entries(byRequest).map(([requestId, optionId]) => ({ optionId, requestId })),
  );
}

/** `sender` types a message into the conversation. */
export function message(
  text: string,
  sender: SessionAuthContext | null = ALICE,
): Extract<Input, { type: "message.received" }> {
  return { sender, text, type: "message.received" };
}

export const cancel: Extract<Input, { type: "cancel.requested" }> = { type: "cancel.requested" };

/** The question a turn asks once its session runs over its input token budget. */
export const BUDGET_QUESTION: InputRequest = {
  action: { callId: "s:limit:input:12", input: {}, kind: "tool-call", toolName: "session-limit" },
  kind: "session-limit",
  options: [
    { id: "continue", label: "Approve" },
    { id: "stop", label: "Stop" },
  ],
  prompt: "Alice's session is over budget. Continue?",
  requestId: "s:limit:input:12",
};

/** The turn's next model call would run over the session's budget. */
export function overBudget(at: RequestAt = AT): Extract<Input, { type: "budget.exceeded" }> {
  return { at, request: BUDGET_QUESTION, type: "budget.exceeded" };
}

/** A turn waiting on the budget question. */
export function waitingOnBudget(): Turn {
  return Turn.idle().input(overBudget());
}

/** An authorization Alice must complete for `name` before her call can run. */
export function challenge(
  attemptId: string,
  overrides: Partial<AuthorizationChallenge> = {},
): AuthorizationChallenge {
  return {
    attemptId,
    challenge: { url: `https://idp.example/authorize/${attemptId}` },
    hookUrl: `https://agent.example/callback/${attemptId}`,
    name: "weather",
    principal: { id: "alice", issuer: "test", type: "user" },
    principalId: "alice",
    requester: ALICE,
    resume: { nonce: attemptId },
    ...overrides,
  };
}

/**
 * Alice's calls `callIds` need these authorizations before they can run; `messages`
 * is the step's response that asked.
 */
export function authorizationRequired(
  challenges: readonly AuthorizationChallenge[],
  callIds: readonly string[] = ["call-weather"],
  messages: readonly ModelMessage[] = [],
): Extract<Input, { type: "authorization.required" }> {
  return {
    at: AT,
    callIds,
    challenges,
    messages,
    requester: ALICE,
    type: "authorization.required",
  };
}

/** A turn waiting on Alice's authorizations. */
export function waitingOnAuthorizations(...challenges: AuthorizationChallenge[]): Turn {
  return Turn.idle().input(authorizationRequired(challenges));
}

/** The identity provider calls back for authorization attempt `attemptId`. */
export function callback(
  attemptId: string,
  connectionName = "weather",
): Extract<Input, { type: "authorization.completed" }> {
  return {
    attemptId,
    callback: { method: "GET", params: { code: "ok" } },
    connectionName,
    outcome: "authorized",
    type: "authorization.completed",
  };
}

/**
 * `session` parked on a model step's runtime calls, as the tool loop leaves
 * it: the step's response held out of history until their results arrive.
 */
export function parkedOnRuntimeCalls<T extends { readonly state?: SessionStateMap }>(
  session: T,
  input: {
    readonly at: RequestAt;
    readonly messages: readonly ModelMessage[];
    readonly tasks: readonly RuntimeWorkflowTaskRequest[];
  },
): T {
  const turn = Turn.from(session.state ?? {}).input({ ...input, type: "actions.dispatched" });
  return { ...session, state: turn.state };
}
