import type { StartWorkflowToolRun } from "#execution/tools/workflow/start.js";
import type { RunInput, Runtime, SessionCommand } from "#channel/types.js";
import type { ActivationOutcome, ActivationRun, Entities } from "#execution/entity/entities.js";
import type { SessionRuntimeConfig } from "#execution/initial-entry.js";
import { createInProcessRuntime } from "#execution/in-process/runtime.js";
import { createWorldSessionStore } from "#execution/in-process/world-store.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import type { RuntimeWorld } from "#execution/world/runtime-world.js";
import { createLogger } from "#internal/logging.js";

// One activation of one session on a World host: the session runs in this process until it
// waits on something to arrive or on a timer, then it's stopped, and its entity keeps it as it
// was (`#execution/entity`).
//   1. A fresh in-process runtime continues the session from what its entity holds: its saved
//      state, or, for a session nothing ran yet, what it was created with (`SessionStart`). It
//      writes through the activation's handle, and reads none of its stream's lines, only how
//      many there are.
//      What the restore started (its runs, a subagent's session) goes on to where it was first.
//   2. What its mailbox holds is handed to the session's addresses, oldest first: a command as
//      its channel sends it, a sign-in callback as its route resumes the address. Keeping one as
//      an input consumes it in the same write; one only the session's memory takes (a callback)
//      is consumed by its next save, or when it stops. So a crash hands each message over until
//      the session kept what it did with it.
//   3. The session runs: its turns, its subagents' sessions and its runs, all here. Once
//      everything waits, and keeps waiting, it's stopped (suspended: nothing it holds is torn
//      down), with its earliest timer as the entity's alarm. A timer due in a moment is waited for.
//   4. Near the activation's deadline, it's stopped wherever a step ends, and the activation
//      continues: the next one goes on with it.

const log = createLogger("execution.world-host.driver");

/**
 * What a World host's session is sent: a command, as a channel sends one, or a payload for one of
 * its addresses, as a callback route or another session resumes it (`via` names the address).
 */
export type SessionMessage =
  | { readonly command: SessionCommand }
  /** Delivered at `token` when it names one (a run's hook), else at the address it was sent to. */
  | { readonly deliver: unknown; readonly token?: string };

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
  /** How often an activation reads its mailbox while its session works (default 1 s). */
  readonly mailboxPollMs?: number;
  /** Where sign-in links send the provider back to (`WorldHostOptions.callbackBaseUrl`). */
  readonly callbackBaseUrl?: string;
  /** The host's runtime for the agent named `name`: where a step reaches other sessions. */
  readonly runtime?: (name: string) => Runtime;
  /** Starts a run of a workflow tool whose body this host doesn't hold (`WorldHostOptions.workflow`). */
  readonly startDurableRun?: StartWorkflowToolRun;
}

/** What runs a session each time its entity is activated. */
export function sessionActivation(options: SessionActivationOptions): ActivationRun {
  const settleMs = options.settleMs ?? 150;
  const holdForTimerMs = options.holdForTimerMs ?? 3_000;
  const mailboxPollMs = options.mailboxPollMs ?? 1_000;
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
      root: sessionId,
    });
    const runtime = createInProcessRuntime(agent.config, {
      servesLines: false,
      world: options.world,
      worldStore: store,
      ...(options.callbackBaseUrl !== undefined && { callbackBaseUrl: options.callbackBaseUrl }),
      ...(options.runtime !== undefined && {
        stepRuntime: () => options.runtime!(start.agent as string),
      }),
      ...(options.startDurableRun !== undefined && { startDurableRun: options.startDurableRun }),
      runOwner: sessionId,
    });
    let outcome: ActivationOutcome = { kind: "continue" };
    try {
      const saved = await runtime.load(sessionId, { lines: "count" });
      if (saved === undefined) await runtime.startSession(sessionId, start.input);
      else {
        await runtime.restore(saved, { stored: true });
        // What it ran goes on to where it was (a subagent reopens its session) before anything
        // arrives: an answer the session forwards to a child finds the child here.
        await settledAfterRestore(runtime, deadline);
      }
      // Each message once: it stays in the mailbox until a save consumes it, so a later read
      // finds it again.
      const handedOver = new Set<string>();
      const handOver = async () => {
        for (const message of await entity.inbox()) {
          if (handedOver.has(message.id)) continue;
          handedOver.add(message.id);
          store.receive(sessionId, message.id);
          const body = message.body as SessionMessage;
          const token = message.via ?? sessionCommandHookToken(sessionId);
          if ("deliver" in body) {
            const at = body.token ?? token;
            // No one here at its address: it's consumed with the rest, so say so.
            if ((await runtime.deliver(at, body.deliver)) === undefined)
              log.warn("a delivery found no one at its address", { sessionId, token: at });
          } else if (message.via === undefined)
            await runtime.dispatchSession({ command: body.command, sessionId });
          else
            await runtime.dispatchContinuation({ command: body.command, continuationToken: token });
          store.received(sessionId);
        }
      };
      await handOver();
      // What arrives while it works (a cancel, a steering message) reaches it as it works, as on
      // Workflow, not only once it stops.
      outcome = await runUntilWaiting(runtime, {
        deadline,
        holdForTimerMs,
        settleMs,
        poll: { every: mailboxPollMs, read: handOver },
      });
      // Out of time with work left: stopped where a step ends, so no call runs twice.
      if (outcome.kind === "continue") await runtime.drain();
    } finally {
      try {
        const ended = runtime.ended(sessionId);
        await runtime.dispose();
        // Stopped, with its state saved: what it took without keeping is consumed now.
        await store.flush(sessionId);
        // A session that ended ends its entity: its addresses are free, and its retention applies.
        if (ended) {
          await entity.end();
          outcome = { kind: "idle" };
        }
      } finally {
        agent.release();
      }
    }
    log.debug("activation ended", { outcome: outcome.kind, sessionId });
    return outcome;
  };
}

const SETTLE_AFTER_RESTORE_MS = 100;

/** Until everything a restore started waits again, or for at most a few seconds. */
async function settledAfterRestore(
  runtime: ReturnType<typeof createInProcessRuntime>,
  deadline: number,
): Promise<void> {
  const until = Math.min(deadline, Date.now() + 5_000);
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  // Waiting, and still waiting a moment later: a restore finishes some of its work after it
  // resolves (a child it reopened claims its addresses).
  while (Date.now() < until) {
    if (
      (await runtime.quiescent()) &&
      (await pause(SETTLE_AFTER_RESTORE_MS), await runtime.quiescent())
    )
      break;
    await pause(10);
  }
}

async function runUntilWaiting(
  runtime: ReturnType<typeof createInProcessRuntime>,
  options: {
    readonly deadline: number;
    readonly settleMs: number;
    readonly holdForTimerMs: number;
    /** Reads the mailbox every `every` ms while the session works. */
    readonly poll?: { readonly every: number; readonly read: () => Promise<void> };
  },
): Promise<ActivationOutcome> {
  const { deadline, holdForTimerMs, poll, settleMs } = options;
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let polled = Date.now();
  while (Date.now() < deadline) {
    if (poll !== undefined && Date.now() - polled >= poll.every) {
      polled = Date.now();
      await poll.read();
    }
    if ((await runtime.quiescent()) && (await pause(settleMs), await runtime.quiescent())) {
      const next = runtime.nextTimer();
      const soon = next !== undefined && next - Date.now() <= holdForTimerMs && next < deadline;
      if (!soon) return next === undefined ? { kind: "idle" } : { kind: "idle", alarm: next };
    }
    await pause(25);
  }
  return { kind: "continue" };
}
