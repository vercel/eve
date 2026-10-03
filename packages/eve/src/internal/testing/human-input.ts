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
