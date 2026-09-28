import type {
  AuthorizationRequiredStreamEvent,
  MessageCompletedStreamEvent,
  TurnFailureStreamEvent,
  UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import { isCurrentTurnBoundaryEvent, isTurnFailureEvent } from "#protocol/message.js";
import type { InputRequest } from "#shared/input.js";

/** A connection authorization challenge that remains unresolved at a turn boundary. */
interface PendingAuthorization {
  readonly authorization?: AuthorizationRequiredStreamEvent["data"]["authorization"];
  readonly description: string;
  readonly name: string;
  readonly attemptId?: string;
  readonly webhookUrl?: string;
}

/** Canonical projection of the lifecycle state represented by one turn's events. */
interface TurnEventSummary {
  readonly boundary: UnstampedMessageStreamEvent | undefined;
  readonly failure: TurnFailureStreamEvent | undefined;
  readonly inputRequests: readonly InputRequest[];
  readonly message: string | undefined;
  readonly pendingAuthorizations: readonly PendingAuthorization[];
  readonly status: "completed" | "failed" | "waiting";
}

/** Reduces one turn's protocol events into their client-facing lifecycle state. */
export function summarizeTurnEvents(
  events: readonly UnstampedMessageStreamEvent[],
): TurnEventSummary {
  const segment = new TurnSegment();
  let boundary: UnstampedMessageStreamEvent | undefined;
  let failure: TurnFailureStreamEvent | undefined;
  let message: string | undefined;

  for (const event of events) {
    if (segment.observe(event)) boundary = event;
    if (isTurnFailureEvent(event)) failure = event;
    if (isFinalMessageCompleted(event)) message = event.data.message ?? undefined;
    // Text completed before the turn parked was interim; the reply comes after it resumes.
    if (event.type === "turn.waiting") message = undefined;
  }

  return {
    boundary,
    failure,
    inputRequests: segment.inputRequests,
    message,
    pendingAuthorizations: segment.pendingAuthorizations,
    status: summarizeBoundaryStatus(boundary),
  };
}

function summarizeBoundaryStatus(
  boundary: UnstampedMessageStreamEvent | undefined,
): TurnEventSummary["status"] {
  if (boundary?.type === "session.waiting" || boundary?.type === "turn.waiting") return "waiting";
  if (boundary?.type === "session.failed") return "failed";
  return "completed";
}

/** Collects one segment of an event stream through its current-turn boundary. */
export async function collectTurnEvents(
  stream: AsyncIterable<UnstampedMessageStreamEvent>,
): Promise<readonly UnstampedMessageStreamEvent[]> {
  const events: UnstampedMessageStreamEvent[] = [];
  const segment = new TurnSegment();
  for await (const event of stream) {
    events.push(event);
    if (segment.observe(event)) break;
  }
  return events;
}

/**
 * Returns true when a read of a session's events ends at `event`: at a current-turn boundary, or
 * at `turn.waiting` while a request is unanswered. The turn stays open there until a person
 * answers; otherwise `turn.waiting` is informational and reading goes on to the turn's real end.
 * A reader that follows sign-in callbacks also reads past `session.waiting` while one is
 * outstanding, because the callback resumes the same turn.
 */
export function endsTurnSegment(
  event: UnstampedMessageStreamEvent,
  open: { readonly callbacks: boolean; readonly requests: boolean },
): boolean {
  if (event.type === "turn.waiting") return open.requests;
  return isCurrentTurnBoundaryEvent(event) && (event.type !== "session.waiting" || !open.callbacks);
}

/** The requests and sign-ins one segment of a session's events leaves open. */
export class TurnSegment {
  readonly #authorizations = new Map<string, PendingAuthorization>();
  readonly #followCallbacks: boolean;
  readonly #requests = new Map<string, InputRequest>();

  constructor(options: { readonly followCallbacks?: boolean } = {}) {
    this.#followCallbacks = options.followCallbacks === true;
  }

  get inputRequests(): readonly InputRequest[] {
    return [...this.#requests.values()];
  }

  get pendingAuthorizations(): readonly PendingAuthorization[] {
    return [...this.#authorizations.values()];
  }

  /** Records `event` and returns true when it ends the segment. */
  observe(event: UnstampedMessageStreamEvent): boolean {
    switch (event.type) {
      case "input.requested":
        for (const request of event.data.requests) this.#requests.set(request.requestId, request);
        break;
      case "approval.settled":
        this.#requests.delete(event.data.requestId);
        break;
      case "input.resolved":
        for (const resolution of event.data.resolutions) {
          this.#requests.delete(resolution.requestId);
        }
        break;
      case "authorization.required":
        this.#authorizations.set(authorizationKey(event.data), event.data);
        break;
      case "authorization.completed":
        this.#authorizations.delete(authorizationKey(event.data));
        break;
    }
    return endsTurnSegment(event, {
      callbacks:
        this.#followCallbacks &&
        [...this.#authorizations.values()].some(
          (authorization) => authorization.webhookUrl !== undefined,
        ),
      requests: this.#requests.size > 0,
    });
  }
}

function isFinalMessageCompleted(
  event: UnstampedMessageStreamEvent,
): event is MessageCompletedStreamEvent {
  return event.type === "message.completed" && event.data.finishReason !== "tool-calls";
}

export function authorizationKey(data: {
  readonly name: string;
  readonly attemptId?: string;
}): string {
  return data.attemptId === undefined ? `name:${data.name}` : `attempt:${data.attemptId}`;
}
