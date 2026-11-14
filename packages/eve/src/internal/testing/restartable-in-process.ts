import { appendFileSync } from "node:fs";
import { expect } from "vitest";

import { deliverToHostedHook, registerHost } from "#execution/hosts.js";
import type { SessionRuntimeConfig } from "#execution/initial-entry.js";
import { createMemoryLineStore } from "#execution/in-process/line-store.js";
import type { WorkflowFunction } from "#execution/in-process/runs.js";
import {
  createInProcessRuntime,
  type InProcessRuntime,
  type InProcessRuntimeOptions,
} from "#execution/in-process/runtime.js";
import { memoryWorld } from "#execution/world/memory-world.js";
import type { RuntimeWorld } from "#execution/world/runtime-world.js";

// An in-process runtime on a World that a test restarts: the runtime is disposed, which suspends
// its sessions on the World, and a fresh one on the same World restores each session that was
// running, as a new process would after a deploy or a crash at rest. The test holds one runtime
// throughout: each call waits out a restart in progress and reaches the runtime serving now, a
// delivery made to a session's address during one reaches it once restored, and the sessions'
// streams are held across restarts, so a reader follows a session through them.
//
// With `restartAtRest`, it restarts on its own each time the host comes to rest after progress
// (a line written since the last restart): every point a session waits on a message, a person,
// a child or a timer is a restart point. It doesn't restart while a run that can't survive one
// (a task, a workflow tool) is running, which would only report that run interrupted.

export interface RestartableInProcessOptions extends InProcessRuntimeOptions {
  /** The World it keeps sessions on; one in this process's memory by default. */
  readonly world?: RuntimeWorld;
  /** Restart each time the host comes to rest after progress. */
  readonly restartAtRest?: boolean;
}

export interface RestartableInProcessRuntime extends InProcessRuntime {
  /** Restarts now: suspends every session, and restores each on a fresh runtime. */
  restart(): Promise<void>;
  /** How many restarts happened so far. */
  restarts(): number;
  /** The World the sessions are kept on. */
  readonly world: RuntimeWorld;
}

/**
 * With `EVE_TEST_RESTART_LOG` set, each restart appends a line to that file naming the test that
 * ran it, so a run can show its restarts happened.
 */
function traceRestart(count: number, sessions: readonly string[]): void {
  const file = process.env.EVE_TEST_RESTART_LOG;
  if (file === undefined || file === "") return;
  let state: { readonly testPath?: string; readonly currentTestName?: string } | undefined;
  try {
    state = expect.getState();
  } catch {
    // Outside a test.
  }
  appendFileSync(
    file,
    `${JSON.stringify({ count, sessions: sessions.length, test: state?.currentTestName, file: state?.testPath })}\n`,
  );
}

/** With `EVE_TEST_RESTART_DEBUG` naming a file, what the restart policy decides goes there. */
const debug = (...args: unknown[]): void => {
  const file = process.env.EVE_TEST_RESTART_DEBUG;
  if (file !== undefined && file !== "")
    appendFileSync(file, `${args.map((arg) => JSON.stringify(arg)).join(" ")}\n`);
};

/** The last line of a session a client reads as at rest: its turn paused, or settled. */
const RESTING = new Set(["turn.paused", "turn.settled", "delivery.settled", "session.started"]);

/** How long input sent to sessions a client saw at rest waits for the host to come to rest. */
const INPUT_REST_WAIT_MS = 1_000;

/** How long the host must stay at rest, with nothing delivered, before it restarts. */
const QUIET_MS = 15;

/** How often the restart loop looks at a host at rest for progress. */
const REST_POLL_MS = 10;

export function createRestartableInProcessRuntime(
  config: SessionRuntimeConfig,
  options: RestartableInProcessOptions = {},
): RestartableInProcessRuntime {
  const { restartAtRest = false, world = memoryWorld(), ...hostOptions } = options;
  const lineStore = createMemoryLineStore();
  const workflows = new Map<string, WorkflowFunction>();
  const make = (): InProcessRuntime => {
    const runtime = createInProcessRuntime(config, { ...hostOptions, lineStore, world });
    for (const [workflowId, body] of workflows) runtime.registerWorkflow(workflowId, body);
    return runtime;
  };

  let restarting: Promise<void> | undefined;
  let count = 0;
  let disposed = false;
  // Deliveries to a session during a restart wait for it, then go to whoever holds the address.
  const releaseGate = registerHost({
    async deliver(token, payload) {
      // A person's message or command routed to a session at rest restarts it first, as a call
      // through the runtime does (`restartedForInput`).
      if (restarting === undefined && isSessionCommand(payload) && (await atRestForInput()))
        await restartLogged();
      if (restarting === undefined) return undefined;
      // Only what a person or a channel sends waits for the sessions to be restored. What the
      // stopping host's own sessions send as they stop (a cancelled call's end, say) waiting on
      // the restart would wait on itself; it reaches nothing, as it would in a process that died.
      if (!isSessionCommand(payload) && !isSignInCallback(payload)) return undefined;
      await restarting.catch(() => {});
      return (await deliverToHostedHook(token, payload)) ? "delivered" : undefined;
    },
    runEnded: () => undefined,
    cancelRun: () => undefined,
  });
  let current = make();
  // Set once the restart policy below is defined.
  let atRestForInput = async (): Promise<boolean> => false;
  let restartLogged = async (): Promise<void> => {};

  const restart = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    restarting ??= (async () => {
      const { sessions } = current.activity();
      debug("suspending", sessions, current.activity().runs);
      await current.dispose();
      debug("suspended");
      current = make();
      for (const sessionId of sessions) {
        // A restored parent's run may have reopened its child already.
        if (current.activity().sessions.includes(sessionId)) continue;
        const saved = await current.load(sessionId);
        if (saved === undefined || current.activity().sessions.includes(sessionId)) continue;
        debug(
          "restore",
          sessionId,
          saved.open,
          saved.inputs,
          saved.runs?.map((r) => r.runId),
          saved.lines.length,
        );
        // A restored parent's run may have reopened its child already.
        await current.restore(saved);
      }
      count += 1;
      debug("restored", count);
      traceRestart(count, sessions);
    })().finally(() => {
      restarting = undefined;
    });
    return restarting;
  };

  /** Waits out a restart in progress, then the runtime serving now. */
  const serving = async (): Promise<InProcessRuntime> => {
    while (restarting !== undefined) await restarting.catch(() => {});
    return current;
  };

  const progress = (): number =>
    lineStore.sessions().reduce((total, id) => total + lineStore.recorded(id).length, 0);
  let restartedAt = progress();
  /**
   * Whether the host is at rest with progress since the last restart: nothing in flight, every
   * session's loop waiting on its inbox (a loop between steps, running hooks say, is no work on
   * the host), and no run running that a restart would only report interrupted.
   */
  const restsAfterProgress = (): boolean => {
    const activity = current.activity();
    return (
      !activity.working &&
      activity.sessions.length > 0 &&
      activity.sessions.every((id) => activity.parked.includes(id)) &&
      activity.runs.every((kind) => kind === "subagent") &&
      progress() !== restartedAt
    );
  };
  /**
   * `restsAfterProgress`, held for a quiet window with nothing delivered in it: a session's loop
   * can wait on its inbox while what it set off (a child's question on its way to its parent's
   * run, say) still moves without counting as work.
   */
  const restsQuietly = async (): Promise<boolean> => {
    if (!restsAfterProgress()) return false;
    const runtime = current;
    const deliveries = runtime.activity().deliveries;
    const lines = progress();
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
    return (
      restarting === undefined &&
      !disposed &&
      current === runtime &&
      runtime.activity().deliveries === deliveries &&
      progress() === lines &&
      restsAfterProgress()
    );
  };
  restartLogged = async (): Promise<void> => {
    await restart().catch((error: unknown) => {
      // A restart that fails leaves its sessions wherever it stopped: the test hangs or fails on
      // what follows, and this says why.
      console.error("restartable in-process runtime: restart failed", error);
    });
    restartedAt = progress();
  };
  /**
   * Before a call that brings input (a message, a command, a new session): a host at rest after
   * progress restarts first, so the input reaches sessions that went on from the World, as it
   * would after the process restarted while they waited.
   */
  const restartedForInput = async (): Promise<InProcessRuntime> => {
    await serving();
    if (restartAtRest && !disposed && (await restsQuietly())) await restartLogged();
    return await serving();
  };
  /**
   * Whether input arriving now finds the host at rest after progress. A client that saw every
   * session's turn pause or settle sends at once, while the step that wrote it is still ending:
   * then it waits, briefly, for the host to come to rest. Input sent mid-turn (steering) is
   * delivered as sent, with no restart.
   */
  atRestForInput = async () => {
    if (!restartAtRest || disposed || progress() === restartedAt) return false;
    const { sessions } = current.activity();
    if (sessions.length === 0 || !sessions.every((id) => RESTING.has(lastLineType(id) ?? "")))
      return false;
    await Promise.race([
      current.idle(),
      new Promise((resolve) => setTimeout(resolve, INPUT_REST_WAIT_MS)),
    ]);
    const rests = !disposed && restarting === undefined && (await restsQuietly());
    debug("input", sessions.map(lastLineType), rests);
    return rests;
  };
  const decoder = new TextDecoder();
  function lastLineType(sessionId: string): string | undefined {
    const line = lineStore.recorded(sessionId).at(-1);
    return line === undefined ? undefined : /"type":"([^"]+)"/.exec(decoder.decode(line))?.[1];
  }
  const restartLoop = async (): Promise<void> => {
    while (!disposed) {
      await (await serving()).idle();
      if (disposed) return;
      if (await restsQuietly()) {
        await restartLogged();
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, REST_POLL_MS));
    }
  };
  if (restartAtRest) void restartLoop();

  return {
    world,
    restart,
    restarts: () => count,
    createSession: async (input) => await (await restartedForInput()).createSession(input),
    dispatchContinuation: async (input) =>
      await (await restartedForInput()).dispatchContinuation(input),
    dispatchSession: async (input) => await (await restartedForInput()).dispatchSession(input),
    resolveContinuation: async (token) => await (await serving()).resolveContinuation(token),
    getEventStream: async (sessionId, streamOptions) =>
      await (await serving()).getEventStream(sessionId, streamOptions),
    getLineStream: async (sessionId, streamOptions) =>
      await (await serving()).getLineStream(sessionId, streamOptions),
    getStreamTailIndex: async (sessionId) => await (await serving()).getStreamTailIndex(sessionId),
    settled: async (sessionId) => {
      // A session suspended by a restart goes on in the next runtime: it settled once none does.
      for (;;) {
        const runtime = await serving();
        await runtime.settled(sessionId);
        if (restarting === undefined && runtime === current) return;
      }
    },
    holds: (token) => current.holds(token),
    stepsRunning: (sessionId) => current.stepsRunning(sessionId),
    idle: async (sessionId) => {
      // At rest means at rest after any restart that rest set off.
      for (;;) {
        const runtime = await serving();
        await runtime.idle(sessionId);
        await new Promise((resolve) => setImmediate(resolve));
        if (restarting === undefined && runtime === current) return;
      }
    },
    startEntry: async (entry, sessionId) => await (await serving()).startEntry(entry, sessionId),
    snapshot: async (sessionId) => await (await serving()).snapshot(sessionId),
    restore: async (snapshot, options) => await (await serving()).restore(snapshot, options),
    load: async (sessionId, options) => await (await serving()).load(sessionId, options),
    sessions: async () => await (await serving()).sessions(),
    activity: () => current.activity(),
    startSession: async (sessionId, input) =>
      await (await serving()).startSession(sessionId, input),
    quiescent: async () => await (await serving()).quiescent(),
    busy: () => current.busy(),
    nextTimer: () => current.nextTimer(),
    drain: async () => await (await serving()).drain(),
    ended: (sessionId) => current.ended(sessionId),
    deliver: async (token, payload) => await (await serving()).deliver(token, payload),
    registerWorkflow(workflowId, body) {
      workflows.set(workflowId, body);
      current.registerWorkflow(workflowId, body);
    },
    end: async (sessionId) => await (await serving()).end(sessionId),
    async dispose(disposeOptions) {
      disposed = true;
      try {
        // Disposing for good ends its sessions, as a host without a World does, unless asked to
        // suspend them.
        await (await serving()).dispose({ suspend: disposeOptions?.suspend ?? false });
      } finally {
        releaseGate();
      }
    },
  };
}

/** What a person or a channel sends a session: a message, or a command. */
function isSessionCommand(payload: unknown): boolean {
  const kind = (payload as { readonly kind?: unknown } | null)?.kind;
  return (
    kind === "send" ||
    kind === "cancel" ||
    kind === "reset" ||
    kind === "compact" ||
    kind === "clear"
  );
}

/** A sign-in's callback, which its asker reads. */
function isSignInCallback(payload: unknown): boolean {
  return (payload as { readonly kind?: unknown } | null)?.kind === "authorization-callback";
}
