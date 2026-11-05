import type { SessionCommand } from "#channel/types.js";
import type { SessionRuntimeConfig } from "#execution/initial-entry.js";
import { createInProcessRuntime } from "#execution/in-process/runtime.js";
import type { SessionSnapshot } from "#execution/in-process/snapshot.js";
import type { QueueWorld } from "#execution/world/runtime-world.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { createLogger } from "#internal/logging.js";
import { readSessionLog } from "./addresses.js";
import { wakeSession } from "./wake.js";

// One wake of one session on a World host: the session runs in this process until it waits on
// something to arrive or on a timer, then it's stopped, and the World keeps it as it was.
//   1. A fresh in-process runtime on the World continues the session from what the World holds:
//      its saved state, or, for a session nothing ran yet, what it started from (`eve.start`).
//   2. What arrived at its addresses since is handed to them, once each: an arrival the session
//      kept or read already is skipped by its delivery id.
//   3. The session runs: its turns, its subagents' sessions and its runs, all here. Once
//      everything waits, and keeps waiting, it's stopped (suspended: nothing it holds is torn
//      down), and a wake is armed for its earliest timer. A timer due in a moment is waited for.
//   4. Near the delivery's deadline, it's stopped wherever a step ends, and the delivery hands
//      off: the same wake comes again at once, and the next delivery continues it.
// The World delivers one wake of a session at a time, so one process runs it at once.

const log = createLogger("execution.world-host.driver");

/** How a wake's delivery ended. */
export type DriveOutcome =
  /** The session waits: on what arrives next, and on its timer at `wakeAt` if it has one. */
  | { readonly kind: "waiting"; readonly wakeAt?: number }
  /** The delivery ran out of time with work left: the next delivery goes on with it. */
  | { readonly kind: "handoff" }
  /** The World holds no session to run for this wake. */
  | { readonly kind: "gone" };

export interface DriveOptions {
  readonly world: QueueWorld;
  readonly sessionId: string;
  /** The agent named `name`, as a runtime runs it, with its release; `undefined` if unknown. */
  readonly agent: (
    name: string,
  ) => { readonly config: SessionRuntimeConfig; readonly release: () => void } | undefined;
  /** When the delivery must stop running the session, epoch milliseconds. */
  readonly deadline: number;
  /** How long everything must stay waiting before the session is stopped. */
  readonly settleMs?: number;
  /** A timer due within this long is waited for, rather than woken for. */
  readonly holdForTimerMs?: number;
}

export async function driveSession(options: DriveOptions): Promise<DriveOutcome> {
  const { world, sessionId, deadline } = options;
  const settleMs = options.settleMs ?? 150;
  const holdForTimerMs = options.holdForTimerMs ?? 3_000;
  const { arrivals, start } = await readSessionLog(world, sessionId);
  if (start === undefined) return { kind: "gone" };
  const agent = options.agent(start.agent);
  if (agent === undefined)
    throw new Error(
      `Session "${sessionId}" runs the agent "${start.agent}", which this host doesn't have.`,
    );
  const runtime = createInProcessRuntime(agent.config, { servesLines: false, world });
  let outcome: DriveOutcome = { kind: "handoff" };
  try {
    const saved = await runtime.load(sessionId);
    if (saved === undefined) await runtime.startSession(sessionId, start.input);
    else await runtime.restore(saved);
    const taken = takenDeliveries(saved);
    for (const arrival of arrivals) {
      const command = arrival.payload as SessionCommand;
      const deliveryId = deliveryIdOf(command);
      if (deliveryId !== undefined && taken.has(deliveryId)) continue;
      await runtime.dispatchContinuation({ command, continuationToken: arrival.token });
    }
    outcome = await runUntilWaiting(runtime, { deadline, holdForTimerMs, settleMs });
    // Out of time with work left: stopped where a step ends, so no call runs twice.
    if (outcome.kind === "handoff") await runtime.drain();
  } finally {
    await runtime.dispose();
    agent.release();
  }
  if (outcome.kind === "waiting" && outcome.wakeAt !== undefined)
    await wakeSession(world, sessionId, { at: outcome.wakeAt });
  log.debug("delivery ended", { outcome: outcome.kind, sessionId });
  return outcome;
}

async function runUntilWaiting(
  runtime: ReturnType<typeof createInProcessRuntime>,
  options: {
    readonly deadline: number;
    readonly settleMs: number;
    readonly holdForTimerMs: number;
  },
): Promise<DriveOutcome> {
  const { deadline, holdForTimerMs, settleMs } = options;
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  while (Date.now() < deadline) {
    if ((await runtime.quiescent()) && (await pause(settleMs), await runtime.quiescent())) {
      const next = runtime.nextTimer();
      const soon = next !== undefined && next - Date.now() <= holdForTimerMs && next < deadline;
      if (!soon)
        return next === undefined ? { kind: "waiting" } : { kind: "waiting", wakeAt: next };
    }
    await pause(25);
  }
  return { kind: "handoff" };
}

/**
 * The deliveries `saved` holds already, by id: those it kept and hasn't read, and those it read
 * or settled, which its state's deliveries record.
 */
function takenDeliveries(saved: SessionSnapshot | undefined): ReadonlySet<string> {
  const taken = new Set<string>();
  if (saved === undefined) return taken;
  for (const input of saved.inputs?.unread ?? []) {
    if (!("command" in input)) continue;
    const deliveryId = deliveryIdOf(input.command);
    if (deliveryId !== undefined) taken.add(deliveryId);
  }
  const { deliveries } = storedProjection(
    saved.checkpoint.sessionState.snapshot.session.state,
  ).view;
  for (const deliveryId of Object.keys(deliveries)) taken.add(deliveryId);
  return taken;
}

function deliveryIdOf(command: SessionCommand): string | undefined {
  switch (command.kind) {
    case "send":
      return command.delivery?.deliveryId;
    case "prewarm":
      return undefined;
    default:
      return "deliveryId" in command ? command.deliveryId : undefined;
  }
}
