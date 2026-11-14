/** Marks the abort reason that steers a turn instead of cancelling it. */
const TURN_STEERED = "eve:turn-steered";

/**
 * The abort reason that steers a turn. It carries the signal of the controller that replaces the
 * steered one, so a step steered while it can't stop (its output or a tool already started) still
 * hears a cancel or a later steer.
 */
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

/**
 * The Workflow-owned abort control prepared before a turn begins. One controller carries both of
 * a turn's interruptions: a cancel aborts it with the cancel's error, a steer with a
 * {@link TurnSteeredReason} naming the controller that replaces it. Each Workflow controller
 * registers a hook, written one at a time, so a second controller per turn would hold the
 * session's boot behind another write. A turn that replaces its controller records the
 * replacement here. One that no turn aborted is left open, as a finished turn's is: nothing
 * listens to it, so aborting it would only add Workflow writes.
 */
export interface TurnControl {
  controller: AbortController;
}

export function createTurnControl(): TurnControl {
  return { controller: new AbortController() };
}

/**
 * The control the next turn starts with. Only a running turn aborts its control, so one `used`
 * left unaborted serves the next turn as well as a new one; only an aborted one is replaced. A new
 * one registers a Workflow abort hook between turns, which a message that arrives as the turn
 * settles would wait behind.
 */
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
