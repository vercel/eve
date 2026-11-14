import type {
  ActivationOutcome,
  ActivationRun,
  ActorHandle,
  ActorMessage,
} from "#execution/actor/actors.js";

// The lifecycle of an activation, whatever the actor runs: it continues the actor from what it
// holds, hands its mailbox over, runs until everything waits (reading what arrives meanwhile, on
// a hint), and stops with its earliest timer as the alarm; near its delivery's deadline, it
// drains to a boundary and continues in the next delivery. An actor kind supplies what's its own
// (`ActorProgram`): how to resume, how to take a message, how to tell it waits, how to stop it.
// A World host's sessions are one such kind (`#execution/world-host/driver.ts`).

/** What one activation of an actor of some kind does, as the loop drives it. */
export interface ActorProgram {
  /** Continues the actor from what it holds, or starts it; resolves once what that started settled. */
  resume(): Promise<void>;
  /** Takes one message from the mailbox. It's handed over once per activation. */
  deliver(message: ActorMessage): Promise<void>;
  /** Whether everything it runs waits on what arrives next or on a timer. */
  quiescent(): Promise<boolean>;
  /**
   * Resolves once nothing it runs is in flight, and that held across a few macrotasks, so what
   * settled work starts next has started. Without it, the loop gives `settleMs` instead.
   */
  idle?(): Promise<void>;
  /** Whether work is in flight now, which `idle` waits out: the loop looks again once it settles. */
  busy?(): boolean;
  /** The earliest timer it waits on, epoch milliseconds. */
  nextTimer(): number | undefined;
  /** Lets running work reach a boundary and starts no more: out of time, it continues next. */
  drain(): Promise<void>;
  /** Stops it, whatever it was doing; `ended` when it's done for good (its actor ends). */
  stop(): Promise<{ readonly ended: boolean }>;
}

export interface ActivationLoopOptions {
  /**
   * How long everything must stay waiting before the activation stops, for a program without
   * `idle` (default 150 ms). One with `idle` stops once it's quiescent again after `idle`.
   */
  readonly settleMs?: number;
  /** A timer due within this long is waited for, not set as the alarm (default 3 s). */
  readonly holdForTimerMs?: number;
  /**
   * How often the loop looks at what it runs while it isn't quiescent with nothing in flight
   * (default 25 ms); work settling and a message arriving have it look at once.
   */
  readonly pollMs?: number;
}

/**
 * Until `program` is quiescent and stays so through `idle` (or `settleMs`), or `until` passes;
 * `interrupt` resolving (a message arrived) ends the wait early too. Resolves whether it came to
 * rest.
 */
export async function untilQuiescent(
  program: Pick<ActorProgram, "quiescent" | "idle" | "busy">,
  options: {
    readonly until: number;
    readonly settleMs?: number;
    readonly pollMs?: number;
    readonly interrupted?: () => boolean;
    readonly interrupt?: () => Promise<void>;
  },
): Promise<boolean> {
  const settleMs = options.settleMs ?? 150;
  const pollMs = options.pollMs ?? 25;
  // The grace before it's taken at its word: what settled work starts next has started by then.
  // Bounded, since work that starts meanwhile (a call that waits on a person) may run for long,
  // and a message arriving cuts it short.
  const settle = async () => {
    const waits: Promise<unknown>[] = [
      program.idle === undefined ? pause(settleMs) : Promise.race([program.idle(), pause(pollMs)]),
    ];
    if (options.interrupt !== undefined) waits.push(options.interrupt());
    await Promise.race(waits);
  };
  // How long it waits before looking again while nothing is in flight but it isn't quiescent
  // either (a session between its waits): from a millisecond, doubling up to `pollMs`.
  let backoff = 1;
  let clearDeadline = () => {};
  const deadline = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, options.until - Date.now()));
    clearDeadline = () => clearTimeout(timer);
  });
  try {
    while (Date.now() < options.until) {
      if (options.interrupted?.() === true) return false;
      if ((await program.quiescent()) && (await settle(), await program.quiescent())) return true;
      if (options.interrupted?.() === true) return false;
      // Looked at again once its work settles or a message arrives; with nothing in flight, after
      // the backoff.
      const waits: Promise<unknown>[] = [];
      if (program.busy?.() === true && program.idle !== undefined) {
        backoff = 1;
        waits.push(program.idle(), deadline);
      } else {
        waits.push(pause(backoff));
        backoff = Math.min(pollMs, backoff * 2);
      }
      if (options.interrupt !== undefined) waits.push(options.interrupt());
      await Promise.race(waits);
    }
  } finally {
    clearDeadline();
  }
  return false;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The activation of an actor whose program `program` makes, each time it's activated. */
export function activationLoop(
  program: (actor: ActorHandle, context: { readonly deadline: number }) => Promise<ActorProgram>,
  options: ActivationLoopOptions = {},
): ActivationRun {
  const holdForTimerMs = options.holdForTimerMs ?? 3_000;
  return async (actor, context) => {
    const { deadline } = context;
    const running = await program(actor, context);
    // A message arrived since the mailbox was last read: the actor's watch says so, and wakes a
    // wait for the program to come to rest.
    let arrived = false;
    let onArrival: (() => void) | undefined;
    const stopWatching = actor.watchInbox(() => {
      arrived = true;
      onArrival?.();
    });
    const nextArrival = () =>
      new Promise<void>((resolve) => {
        onArrival = resolve;
      });
    const handedOver = new Set<string>();
    // Each message once: it stays in the mailbox until a write consumes it, so a later read
    // finds it again.
    const handOver = async () => {
      arrived = false;
      for (const message of await actor.inbox()) {
        if (handedOver.has(message.id)) continue;
        handedOver.add(message.id);
        await running.deliver(message);
      }
    };
    let outcome: ActivationOutcome = { kind: "continue" };
    try {
      await running.resume();
      await handOver();
      outcome = await (async (): Promise<ActivationOutcome> => {
        while (Date.now() < deadline) {
          if (arrived) await handOver();
          const rested = await untilQuiescent(running, {
            interrupt: nextArrival,
            interrupted: () => arrived,
            until: deadline,
            ...(options.settleMs !== undefined && { settleMs: options.settleMs }),
            ...(options.pollMs !== undefined && { pollMs: options.pollMs }),
          });
          // Stopping now would leave what arrived meanwhile to the next activation.
          if (!rested || arrived) continue;
          const next = running.nextTimer();
          const soon = next !== undefined && next - Date.now() <= holdForTimerMs && next < deadline;
          if (!soon) return next === undefined ? { kind: "idle" } : { alarm: next, kind: "idle" };
          // A timer due in a moment: waited for here, as what it starts makes it busy.
          await Promise.race([pause(Math.max(0, next - Date.now())), nextArrival()]);
        }
        return { kind: "continue" };
      })();
      if (outcome.kind === "continue") await running.drain();
    } finally {
      stopWatching();
      const { ended } = await running.stop();
      // Done for good: its addresses are free, and nothing activates it again.
      if (ended) {
        await actor.end();
        outcome = { kind: "idle" };
      }
    }
    return outcome;
  };
}
