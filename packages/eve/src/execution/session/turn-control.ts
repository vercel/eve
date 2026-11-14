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

/**
 * A turn step's two interruptions, read from the signal its turn carries: a steer aborts
 * `steeringSignal` and the step goes on following the steer's replacement signal, and anything
 * else aborts `abortSignal` with the same reason.
 */
export function splitTurnSignal(signal: AbortSignal): {
  readonly abortSignal: AbortSignal;
  readonly steeringSignal: AbortSignal;
} {
  const cancellation = new AbortController();
  const steering = new AbortController();
  const follow = (current: AbortSignal) => {
    const apply = () => {
      if (isTurnSteeredReason(current.reason)) {
        steering.abort();
        follow(current.reason.next);
      } else {
        cancellation.abort(current.reason);
      }
    };
    if (current.aborted) apply();
    else current.addEventListener("abort", apply, { once: true });
  };
  follow(signal);
  return { abortSignal: cancellation.signal, steeringSignal: steering.signal };
}
