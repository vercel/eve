import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import {
  foldSession,
  initialSessionProjection,
  openInputs,
  openSignIns,
  type SessionProjection,
} from "#protocol/session-projection.js";

// A test oracle for what every reader of a session stream relies on. It folds the stream with
// the projection readers use and checks each event against what came before. eve doesn't ship
// it: tests run it where they read a session's stream.

export interface SessionContractViolation {
  readonly rule: "turn-order" | "resolved-twice" | "open-after-owner" | "unsettled-call";
  readonly message: string;
  readonly event: UnstampedMessageStreamEvent;
}

const TURN_CONTENT: ReadonlySet<UnstampedMessageStreamEvent["type"]> = new Set([
  "step.started",
  "message.appended",
  "reasoning.appended",
  "actions.requested",
]);

/** Checks a session stream event by event; `observe` returns the event's violations. */
export function createSessionContract() {
  let projection: SessionProjection = initialSessionProjection();
  const resolved = new Set<string>();
  const cancelledTurns = new Set<string>();
  let cleared = false;
  // A reader that joins mid-stream can't know the turn its first events belong to.
  let joined = false;

  return {
    get projection(): SessionProjection {
      return projection;
    },
    observe(event: UnstampedMessageStreamEvent): readonly SessionContractViolation[] {
      const violations: SessionContractViolation[] = [];
      const violate = (rule: SessionContractViolation["rule"], message: string) =>
        violations.push({ event, message, rule });
      const before = projection;

      if (before.ended) violate("turn-order", `${event.type} after the session ended`);
      if (event.type === "turn.started" && before.activeTurnId !== undefined) {
        violate(
          "turn-order",
          `turn ${event.data.turnId} started while ${before.activeTurnId} is open`,
        );
      }
      if (event.type === "turn.started" || event.type === "session.started") joined = true;
      if (joined && TURN_CONTENT.has(event.type) && before.activeTurnId === undefined) {
        violate("turn-order", `${event.type} outside a turn`);
      }
      if (event.type === "input.resolved") {
        for (const { requestId } of event.data.resolutions) {
          if (resolved.has(requestId))
            violate("resolved-twice", `request ${requestId} resolved twice`);
          resolved.add(requestId);
        }
      }
      // v26 cancellation ends unfinished calls without publishing synthetic tool results.
      if (event.type === "turn.completed") {
        for (const call of Object.values(before.calls)) {
          if (call.turnId !== event.data.turnId || call.taskId !== undefined) continue;
          if (call.status === "running") {
            violate("unsettled-call", `${event.type} left call ${call.callId} running`);
          }
        }
      }
      if (event.type === "turn.cancelled") cancelledTurns.add(event.data.turnId);
      if (event.type === "context.cleared") cleared = true;

      projection = foldSession(projection, event);

      if (event.type === "session.waiting" || event.type === "session.completed") {
        for (const input of openInputs(projection)) {
          const relayed = input.callId !== undefined || input.taskId !== undefined;
          if (cancelledTurns.has(input.turnId) || (cleared && !relayed)) {
            violate("open-after-owner", `request ${input.request.requestId} outlived its owner`);
          }
        }
        for (const attempt of openSignIns(projection)) {
          if (cancelledTurns.has(attempt.turnId) || cleared) {
            violate("open-after-owner", `sign-in ${attempt.attemptId} outlived its owner`);
          }
        }
        if (event.type === "session.completed" && openInputs(projection).length > 0) {
          violate("open-after-owner", "requests are open when the session completed");
        }
        cancelledTurns.clear();
        cleared = false;
      }
      return violations;
    },
  };
}

/** Throws on the first event that breaks the contract, naming the rule. */
export function assertSessionContract(events: readonly UnstampedMessageStreamEvent[]): void {
  const contract = createSessionContract();
  for (const [index, event] of events.entries()) {
    const [violation] = contract.observe(event);
    if (violation !== undefined) {
      throw new Error(
        `Session stream contract (${violation.rule}) at event ${index}: ${violation.message}`,
      );
    }
  }
}
