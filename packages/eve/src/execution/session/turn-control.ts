const TURN_STEERED = "eve:turn-steered";

export interface TurnSteeredReason {
  readonly [TURN_STEERED]: true;
  readonly next: AbortSignal;
}

export function turnSteeredReason(next: AbortSignal): TurnSteeredReason {
  return { [TURN_STEERED]: true, next };
}

function isTurnSteeredReason(reason: unknown): reason is TurnSteeredReason {
  return (
    typeof reason === "object" &&
    reason !== null &&
    (reason as Record<string, unknown>)[TURN_STEERED] === true
  );
}

export interface TurnControl {
  controller: AbortController;
}

export function createTurnControl(): TurnControl {
  return { controller: new AbortController() };
}

export function nextTurnControl(used: TurnControl): TurnControl {
  return used.controller.signal.aborted ? createTurnControl() : used;
}

const ABORT_READER_CANCEL = Symbol.for("WORKFLOW_ABORT_READER_CANCEL");

export function splitTurnSignal(signal: AbortSignal): {
  readonly abortSignal: AbortSignal;
  readonly steeringSignal: AbortSignal;
  release(): void;
} {
  const cancellation = new AbortController();
  const steering = new AbortController();
  const releases: (() => void)[] = [];
  const follow = (current: AbortSignal) => {
    const apply = () => {
      if (isTurnSteeredReason(current.reason)) {
        steering.abort();
        const { next } = current.reason;
        releases.push(() =>
          (next as { [ABORT_READER_CANCEL]?: AbortController })[ABORT_READER_CANCEL]?.abort(),
        );
        follow(next);
      } else {
        cancellation.abort(current.reason);
      }
    };
    if (current.aborted) apply();
    else {
      current.addEventListener("abort", apply, { once: true });
      releases.push(() => current.removeEventListener("abort", apply));
    }
  };
  follow(signal);
  return {
    abortSignal: cancellation.signal,
    steeringSignal: steering.signal,
    release: () => releases.forEach((release) => release()),
  };
}
