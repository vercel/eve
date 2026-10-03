import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import {
  HumanInput,
  type HumanInputEvent,
  type Intake,
  type Interrupt,
  type Next,
  type RequestAt,
} from "#harness/human-input/index.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

/** Scenario builders for the `HumanInput` rule tests, which read as given, when, then. */

/** Where Alice's turn asked: its first model step. */
export const AT: RequestAt = { sequence: 1, stepIndex: 0, turnId: "turn_1" };

function person(principalId: string): SessionAuthContext {
  return { attributes: {}, authenticator: "test", principalId, principalType: "user" };
}

/** Alice started the turn. */
export const ALICE = person("alice");

type Published<T extends UnstampedMessageStreamEvent["type"]> = Extract<
  UnstampedMessageStreamEvent,
  { type: T }
>;

/** A turn's human input, and the events the last thing that happened to it reported. */
export class Turn {
  readonly humanInput: HumanInput;
  readonly events: readonly HumanInputEvent[];

  private constructor(humanInput: HumanInput, events: readonly HumanInputEvent[]) {
    this.humanInput = humanInput;
    this.events = events;
  }

  /** A turn that waits on nobody. */
  static idle(): Turn {
    return new Turn(HumanInput.read(undefined), []);
  }

  interrupt(interrupt: Interrupt): Turn {
    const { events, humanInput } = this.humanInput.interrupt(interrupt);
    return new Turn(humanInput, events);
  }

  intake(intake: Intake): Turn {
    const { events, humanInput } = this.humanInput.intake(intake);
    return new Turn(humanInput, events);
  }

  /** The same turn after the session stores it and reads it back, as between steps. */
  stored(): Turn {
    return new Turn(HumanInput.read(this.humanInput.write(undefined)), this.events);
  }

  next(): Next {
    return this.humanInput.next();
  }

  /** The events of `type` the runtime is told to carry out. */
  reported<T extends HumanInputEvent["type"]>(type: T): Extract<HumanInputEvent, { type: T }>[] {
    return this.events.filter(
      (event): event is Extract<HumanInputEvent, { type: T }> => event.type === type,
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
    return this.reported("history.appended").map((event) => event.message);
  }

  /** Nothing is stored for the session once nothing is open. */
  storesNothing(): boolean {
    return this.humanInput.write(undefined) === undefined;
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
  options: Partial<Extract<Interrupt, { type: "approvals.requested" }>> = {},
): Interrupt {
  return {
    approvalKeys: {},
    at: AT,
    messages: stepResponse(requests),
    requester: ALICE,
    requests,
    responsePolicyRequestIds: [],
    type: "approvals.requested",
    ...options,
  };
}

/** A turn held because Alice's model step asked to run each of `toolNames`. */
export function heldOnApprovals(...toolNames: string[]): Turn {
  return Turn.idle().interrupt(approvalsRequested(toolNames.map((name) => approval(name))));
}

/** `responder` sends these answers at once, in this order. */
export function answered(
  responses: readonly InputResponse[],
  responder: SessionAuthContext | null = ALICE,
): Intake {
  return { responder, responses, type: "answered" };
}

/** `responder` picks `optionId` for request `requestId`. */
export function answer(
  optionId: string,
  requestId: string,
  responder: SessionAuthContext | null = ALICE,
): Intake {
  return answered([{ optionId, requestId }], responder);
}

/** Alice answers several requests at once, in this order. */
export function answers(byRequest: Readonly<Record<string, string>>): Intake {
  return answered(
    Object.entries(byRequest).map(([requestId, optionId]) => ({ optionId, requestId })),
  );
}

/** `sender` types a message into the conversation. */
export function message(text: string, sender: SessionAuthContext | null = ALICE): Intake {
  return { sender, text, type: "message" };
}

export const cancel: Intake = { type: "cancelled" };

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
export function overBudget(at: RequestAt = AT): Interrupt {
  return { at, request: BUDGET_QUESTION, type: "budget.exceeded" };
}

/** A turn held on the budget question. */
export function heldOnBudget(): Turn {
  return Turn.idle().interrupt(overBudget());
}
