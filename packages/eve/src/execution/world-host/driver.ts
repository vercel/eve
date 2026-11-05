import type { RunInput, SessionCommand } from "#channel/types.js";
import type { ActivationOutcome, ActivationRun, Entities } from "#execution/entity/entities.js";
import type { SessionRuntimeConfig } from "#execution/initial-entry.js";
import { createInProcessRuntime } from "#execution/in-process/runtime.js";
import { createWorldSessionStore } from "#execution/in-process/world-store.js";
import type { RuntimeWorld } from "#execution/world/runtime-world.js";
import { createLogger } from "#internal/logging.js";

// One activation of one session on a World host: the session runs in this process until it
// waits on something to arrive or on a timer, then it's stopped, and its entity keeps it as it
// was (`#execution/entity`).
//   1. A fresh in-process runtime continues the session from what its entity holds: its saved
//      state, or, for a session nothing ran yet, what it was created with (`SessionStart`). It
//      writes through the activation's handle, and reads none of its stream's lines, only how
//      many there are.
//   2. What its mailbox holds is handed to the session's addresses, oldest first. Keeping one as
//      an input consumes it in the same write; one the session doesn't keep is consumed after.
//      So a crash hands each message over once.
//   3. The session runs: its turns, its subagents' sessions and its runs, all here. Once
//      everything waits, and keeps waiting, it's stopped (suspended: nothing it holds is torn
//      down), with its earliest timer as the entity's alarm. A timer due in a moment is waited for.
//   4. Near the activation's deadline, it's stopped wherever a step ends, and the activation
//      continues: the next one goes on with it.

const log = createLogger("execution.world-host.driver");

/** What a World host's session is created with: its entity's meta. */
export interface SessionStart {
  /** The agent's name, which the host that runs the session finds it by. */
  readonly agent: string;
  readonly input: RunInput;
}

export interface SessionActivationOptions {
  readonly world: RuntimeWorld;
  readonly entities: Entities;
  /** The agent named `name`, as a runtime runs it, with its release; `undefined` if unknown. */
  readonly agent: (
    name: string,
  ) => { readonly config: SessionRuntimeConfig; readonly release: () => void } | undefined;
  /** How long everything must stay waiting before the session is stopped. */
  readonly settleMs?: number;
  /** A timer due within this long is waited for, rather than set as the alarm. */
  readonly holdForTimerMs?: number;
}

/** What runs a session each time its entity is activated. */
export function sessionActivation(options: SessionActivationOptions): ActivationRun {
  const settleMs = options.settleMs ?? 150;
  const holdForTimerMs = options.holdForTimerMs ?? 3_000;
  return async (entity, { deadline }) => {
    const sessionId = entity.key;
    const start = entity.meta as Partial<SessionStart> | undefined;
    if (typeof start?.agent !== "string" || start.input === undefined)
      throw new Error(`Session "${sessionId}" wasn't started by a World host.`);
    const agent = options.agent(start.agent);
    if (agent === undefined)
      throw new Error(
        `Session "${sessionId}" runs the agent "${start.agent}", which this host doesn't have.`,
      );
    const store = createWorldSessionStore(options.world, {
      entities: options.entities,
      handles: (key) => (key === sessionId ? entity : undefined),
    });
    const runtime = createInProcessRuntime(agent.config, {
      servesLines: false,
      world: options.world,
      worldStore: store,
    });
    let outcome: ActivationOutcome = { kind: "continue" };
    try {
      const saved = await runtime.load(sessionId, { lines: "count" });
      if (saved === undefined) await runtime.startSession(sessionId, start.input);
      else await runtime.restore(saved, { stored: true });
      for (const message of await entity.inbox()) {
        const command = message.body as SessionCommand;
        store.receive(sessionId, message.id);
        if (message.via === undefined) await runtime.dispatchSession({ command, sessionId });
        else await runtime.dispatchContinuation({ command, continuationToken: message.via });
        await store.received(sessionId);
      }
      outcome = await runUntilWaiting(runtime, { deadline, holdForTimerMs, settleMs });
      // Out of time with work left: stopped where a step ends, so no call runs twice.
      if (outcome.kind === "continue") await runtime.drain();
    } finally {
      await runtime.dispose();
      agent.release();
    }
    log.debug("activation ended", { outcome: outcome.kind, sessionId });
    return outcome;
  };
}

async function runUntilWaiting(
  runtime: ReturnType<typeof createInProcessRuntime>,
  options: {
    readonly deadline: number;
    readonly settleMs: number;
    readonly holdForTimerMs: number;
  },
): Promise<ActivationOutcome> {
  const { deadline, holdForTimerMs, settleMs } = options;
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  while (Date.now() < deadline) {
    if ((await runtime.quiescent()) && (await pause(settleMs), await runtime.quiescent())) {
      const next = runtime.nextTimer();
      const soon = next !== undefined && next - Date.now() <= holdForTimerMs && next < deadline;
      if (!soon) return next === undefined ? { kind: "idle" } : { kind: "idle", alarm: next };
    }
    await pause(25);
  }
  return { kind: "continue" };
}
