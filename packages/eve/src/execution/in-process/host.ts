import type { StartWorkflowToolRun } from "#execution/tools/workflow/start.js";
import type { Runtime, SessionCommand, SessionCommandResult } from "#channel/types.js";
import { agentSessionsOver } from "#execution/agent-sessions/sessions-over.js";
import { dispatchCoordinationOn } from "#execution/coordination-dispatch-step.js";
import { registerHost } from "#execution/hosts.js";
import type { SessionRuntimeConfig } from "#execution/initial-entry.js";
import {
  activeCommandResult,
  identifyCommand,
  inactiveCommandResult,
} from "#execution/session-commands.js";
import {
  logicalSessionInboxToken,
  sessionCommandHookToken,
} from "#execution/session-inbox/address.js";
import type { SessionHost, SessionMoves, StartedSession } from "#execution/session/program.js";
import { turnStepOn, type SessionStepHost } from "#execution/session/turn-step.js";
import { applyRunMessagesOn } from "#execution/tools/workflow/apply-run-messages.js";
import { createUlid } from "#shared/ulid.js";
import { createMemoryInboxRegistry, type MemoryInboxRegistry } from "./inbox-transport.js";
import { createMemoryLineStore } from "./line-store.js";
import { createInProcessRuns, type InProcessRuns } from "./runs.js";
import type { HostedSession } from "./session-record.js";
import { memoryWorld } from "#execution/world/memory-world.js";
import type { RuntimeWorld } from "#execution/world/runtime-world.js";
import type { InProcessRuntime } from "./runtime.js";
import { stoppableStore, type SessionStore } from "./session-store.js";
import { createWorldSessionStore, type WorldSessionStore } from "./world-store.js";
import { acrossStepBoundary, structuredCloneBoundary, type StepBoundary } from "./step-boundary.js";
import { createInProcessTimers, type InProcessTimers } from "./timers.js";

// What every runtime of one in-process host shares: its stores, addresses, timers and runs, the
// sessions running on any of its runtimes, and the route that sends hook tokens it holds here
// instead of to Workflow. A run's child sessions run on the host's runtime for the child's agent
// (`runtimeFor`), beside the parent's.

const IN_PROCESS_DEPLOYMENT_ID = "in-process";

/** A session here never moves: there is one owner, in this process. */
const IN_PROCESS_MOVES: SessionMoves = {
  adoptTakeover: async () => {
    throw new Error("An in-process session can't be taken over.");
  },
  awaitAnchoredResult: async () => {
    throw new Error("An in-process session never moves, so nothing anchors it.");
  },
  disposeAnchor: async () => {},
  tryCompactionTransfer: async () => ({ kind: "retained", reason: "same-deployment" }),
  tryPrewarmTransfer: async () => ({ kind: "retained", reason: "same-deployment" }),
  tryTransfer: async () => ({ kind: "retained", reason: "same-deployment" }),
};

/** Whether `settled` resolves without waiting on anything but what's already done. */
async function settledNow(settled: Promise<void>): Promise<boolean> {
  return await Promise.race([
    settled.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0)),
  ]);
}

function unavailable(what: string): never {
  throw new Error(
    `${what} needs a deployment, which an in-process session doesn't have. Run the agent with \`eve dev\` or deploy it.`,
  );
}

/**
 * The runtime a turn step's own durable calls start in. A session's runs start through its
 * host's dispatch instead, so nothing here does.
 */
const NO_STEP_RUNTIME: Runtime = {
  createSession: async () => unavailable("Starting a session from a tool"),
  dispatchContinuation: async () => unavailable("Sending to another session"),
  dispatchSession: async () => unavailable("Sending to another session"),
  getEventStream: async () => unavailable("Reading another session"),
  getLineStream: async () => unavailable("Reading another session"),
  getStreamTailIndex: async () => unavailable("Reading another session"),
  resolveContinuation: async () => unavailable("Resolving another session"),
};

/** How an in-process host keeps and serves its sessions. */
export interface InProcessHostOptions {
  /**
   * The World each session is kept on as it runs: its lines and accepted inputs as they arrive,
   * the rest at every step boundary, so another runtime on the same World continues it after a
   * crash. Given one, disposing the runtime suspends its sessions instead of ending them.
   * Without one, sessions are runs on a World in this process's memory, and end with the
   * runtime.
   */
  readonly world?: RuntimeWorld;
  /**
   * Where the server this host runs in routes eve's callbacks (`/.well-known/eve/...`), which
   * sign-in links name. Without one, a tool that needs a sign-in can't ask for it.
   */
  readonly callbackBaseUrl?: string;
  /**
   * What a step's data and a hook's payload cross: a structured clone by default. Workflow's
   * serializer (`workflowStepBoundary`) hands steps exactly what a deployment would.
   */
  readonly stepBoundary?: StepBoundary;
  /**
   * Whether readers in this process read the sessions here from this host's memory, as they're
   * kept. A World host's runtimes don't: a session runs in many short deliveries, and its readers
   * follow its World throughout (`registerFallbackLineStore`). Defaults to `true`.
   */
  readonly servesLines?: boolean;
  /**
   * The store its sessions are kept in, when its creator holds one already: a World host's
   * delivery, which writes through its activation's handle and consumes its messages
   * (`WorldSessionStore.receive`). Its readers read from the World, so a takeover reaches them
   * there. Without one, a store on `world`.
   */
  readonly worldStore?: WorldSessionStore;
  /**
   * The runtime a step reaches other sessions through (`ctx.to()`, a tool starting a session):
   * a World host's, whose sessions run wherever their activations do. Without one, a step can't.
   */
  readonly stepRuntime?: () => Runtime;
  /**
   * Starts a durable run (Workflow's) of a workflow tool whose body this host doesn't hold: an
   * authored one, on a deployment that also runs Workflow. Without one, its run fails.
   */
  readonly startDurableRun?: StartWorkflowToolRun;
}

/** A session running here: what the host records of it, and its loop. */
export interface LiveSession {
  readonly record: HostedSession;
  readonly loop: StartedSession;
}

export interface InProcessHost {
  readonly deploymentId: string;
  readonly lines: ReturnType<typeof createMemoryLineStore>;
  readonly inboxes: MemoryInboxRegistry;
  readonly timers: InProcessTimers;
  readonly runs: InProcessRuns;
  /** The World the host's sessions are runs on. */
  readonly world: RuntimeWorld;
  /** Its sessions on the World, until `dispose` stops writing to it. */
  readonly store: SessionStore;
  /** Whether the host keeps its sessions for another runtime: it was given a World. */
  readonly keeps: boolean;
  /** Whether readers here read its sessions from its memory; see `servesLines`. */
  readonly servesLines: boolean;
  /** The record of each session as it boots and runs here, by session id. */
  readonly records: Map<string, HostedSession>;
  /** Each session's loop, once it runs. */
  readonly sessions: Map<string, LiveSession>;
  /** Each running session's end. */
  readonly running: Map<string, Promise<void>>;
  /** The host a session's loop runs on, which `recorder` keeps. */
  sessionHost(recorder: HostedSession): SessionHost;
  /** Delivers a command to the session holding `token`, which keeps it first. */
  deliverCommand<TCommand extends SessionCommand>(
    token: string,
    command: TCommand,
  ): Promise<SessionCommandResult<TCommand>>;
  /**
   * Whether the host suspended its sessions: it was disposed with a store keeping them, so they
   * stop without ending (`SessionRecorder.suspended`).
   */
  suspended(): boolean;
  /**
   * Whether nothing here runs, or is about to: no delivery is on its way, every session waits on
   * its addresses or a timer with no step running, and every run is replayable (a subagent's,
   * `ask_question`'s), waiting on its hooks. Stopped now, each would continue from its World as
   * it is, woken by what arrives next or by its next timer (`timers.next()`). An authored
   * workflow tool's run doesn't survive a stop, so a host running one isn't quiescent.
   */
  quiescent(): Promise<boolean>;
  /**
   * Lets each running step finish and be saved, and starts no other: resolves once every session
   * is between steps. A step that would start waits until `dispose`, which stops it unstarted, so
   * a host disposed after draining leaves each session at a step boundary.
   */
  drain(): Promise<void>;
  /** Releases `release` when the host is disposed. */
  onDispose(release: () => void): void;
  /** Stops serving: suspends the sessions a store keeps, and ends the rest. */
  dispose(): Promise<void>;
}

/**
 * The host every runtime `runtimeFor` returns shares. It reaches a child's runtime through
 * `runtimeFor`, which also reopens a child a run opened before a restore.
 */
export function createInProcessHost(
  options: InProcessHostOptions,
  runtimeFor: (config: SessionRuntimeConfig) => InProcessRuntime,
): InProcessHost {
  const lines = createMemoryLineStore();
  const stepBoundary = options.stepBoundary ?? structuredCloneBoundary;
  const inboxes = createMemoryInboxRegistry(stepBoundary);
  const timers = createInProcessTimers();
  const world = options.world ?? memoryWorld();
  const onWorld =
    options.worldStore ??
    createWorldSessionStore(world, {
      // Another process continued a session: what this one writes of it is refused from now on,
      // and its readers here hear why after the lines it kept.
      onTakenOver: (sessionId, error) => lines.fail(sessionId, error),
    });
  const kept = options.world === undefined ? undefined : stoppableStore(onWorld);
  const store = kept?.store ?? onWorld;
  const records = new Map<string, HostedSession>();
  const sessions = new Map<string, LiveSession>();
  const running = new Map<string, Promise<void>>();
  const releases: (() => void)[] = [];
  let suspending = false;
  // Once draining, a step that would start waits for `dispose`, which refuses it.
  let draining: Promise<never> | undefined;
  let refuseDrained: (error: Error) => void = () => {};
  /** How many of each session's waits are on a timer (`SessionHost.sleep`). */
  const sleeping = new Map<string, number>();
  const sleepFor = (sessionId: string) => async (ms: number) => {
    sleeping.set(sessionId, (sleeping.get(sessionId) ?? 0) + 1);
    try {
      await timers.until(Date.now() + ms);
    } finally {
      const left = (sleeping.get(sessionId) ?? 1) - 1;
      if (left === 0) sleeping.delete(sessionId);
      else sleeping.set(sessionId, left);
    }
  };

  const deliverCommand: InProcessHost["deliverCommand"] = async (token, command) => {
    const identified = identifyCommand(command);
    const delivery = await inboxes.deliver(token, identified);
    return delivery?.kind === "delivered"
      ? activeCommandResult(identified, delivery.owner)
      : inactiveCommandResult(identified);
  };
  const dispatchSession: Runtime["dispatchSession"] = async ({ command, sessionId }) =>
    await deliverCommand(sessionCommandHookToken(sessionId), command);

  const runs = createInProcessRuns({
    ...(options.startDurableRun !== undefined && { startDurableRun: options.startDurableRun }),
    dispatchSession,
    inboxes,
    stepBoundary,
    async reopenSession(config, sessionId, { idle }) {
      if (sessions.has(sessionId)) return true;
      const saved = await store?.load(sessionId);
      if (saved === undefined) return false;
      // Between turns, with nothing unread, it has no turn left to reply from.
      if (!idle && saved.open === undefined && (saved.inputs?.unread.length ?? 0) === 0)
        return false;
      await runtimeFor(config).restore(saved);
      return true;
    },
    runtimeFor,
    timers,
  });

  // A child a run opened after its task ended is stopped, best effort, as on Workflow.
  const { stopLate } = agentSessionsOver({
    deliveryId: (kind, sessionId) => `agent-session:late:${createUlid()}:${sessionId}:${kind}`,
    local: {
      start: async () => {
        throw new Error("A session's children are opened by its runs.");
      },
      command: async (session, command) =>
        await dispatchSession({ command, sessionId: session.address.sessionId }),
      async commandLate(sessionId, command) {
        await dispatchSession({ command, sessionId });
      },
    },
    remote: undefined,
  });
  const applyRunMessages = applyRunMessagesOn({
    // A remote child can't be opened here, so no run reports one.
    recordRemoteBinding: async () => unavailable("A remote agent"),
    stopLate,
  });
  const dispatchRuns = dispatchCoordinationOn(runs.startRun);

  const stepHost: SessionStepHost = {
    ...(options.callbackBaseUrl !== undefined && {
      callbackBaseUrl: options.callbackBaseUrl.replace(/\/$/, ""),
    }),
    createRuntime: () => options.stepRuntime?.() ?? NO_STEP_RUNTIME,
    // Attributes belong to a Workflow run; an in-process session has none.
    setAttributes: async () => {},
  };
  const runTurnStep = turnStepOn(stepHost);
  /**
   * One turn step, whose data crosses the host's step boundary each way as it would a
   * deployment's serializer. Its stream and signals are services, which cross as they are.
   */
  const runTurnStepAcrossBoundary: SessionHost["runTurnStep"] = async (input) => {
    if (draining !== undefined) await draining;
    const { abortSignal, sessionWritable, steeringSignal, ...data } = input;
    const crossed = await acrossStepBoundary(stepBoundary, data);
    return await acrossStepBoundary(
      stepBoundary,
      await runTurnStep({ ...crossed, abortSignal, sessionWritable, steeringSignal }),
    );
  };

  releases.push(
    registerHost({
      async deliver(token, payload) {
        // A session's addresses are named here by their logical tokens.
        const delivery = await inboxes.deliver(logicalSessionInboxToken(token) ?? token, payload);
        return delivery?.kind;
      },
      runEnded: (runId) => runs.runEnded(runId),
      cancelRun: (runId, reason) => runs.cancelRun(runId, reason),
    }),
  );

  return {
    deliverCommand,
    deploymentId: IN_PROCESS_DEPLOYMENT_ID,
    inboxes,
    lines,
    records,
    running,
    runs,
    sessions,
    keeps: kept !== undefined,
    servesLines: options.servesLines ?? true,
    store,
    timers,
    world,
    sessionHost: (recorder) => ({
      applyRunMessages,
      dispatchRuns,
      moves: IN_PROCESS_MOVES,
      recorder,
      runTurnStep: runTurnStepAcrossBoundary,
      sleep: sleepFor(recorder.sessionId),
    }),
    suspended: () => suspending,
    async quiescent() {
      if (!inboxes.quiet()) return false;
      for (const [sessionId, live] of sessions) {
        if (!(await settledNow(live.loop.settledStep()))) return false;
        if (!inboxes.waiting(sessionId) && !sleeping.has(sessionId)) return false;
      }
      // A run waiting on its hooks may stop with the session if it goes on after a restore.
      for (const run of runs.active())
        if (!run.replayable || !inboxes.waiting(run.runId)) return false;
      // A delivery may have started crossing while this looked.
      return inboxes.quiet();
    },
    async drain() {
      if (draining === undefined) {
        draining = new Promise<never>((_, reject) => (refuseDrained = reject));
        draining.catch(() => {});
      }
      // A session a step opened (a subagent's) may start its first step meanwhile.
      for (let settled = 0; settled !== sessions.size;) {
        settled = sessions.size;
        await Promise.all([...sessions.values()].map(({ loop }) => loop.settledStep()));
      }
    },
    onDispose(release) {
      releases.push(release);
    },
    async dispose() {
      // Sessions on a World the runtime was given are suspended: the World holds them as they
      // were, and closing their addresses stops their loops without ending them, so restore
      // continues them with their sandboxes and children, as after a crash. Otherwise, closing
      // ends them.
      suspending = kept !== undefined;
      // What sessions wrote is kept before the World stops being written to, so a suspended
      // session's stream holds every line it wrote.
      if (kept !== undefined) await lines.flushAll().catch(() => {});
      kept?.stop();
      refuseDrained(new Error("The host stopped before this step started."));
      inboxes.closeAll();
      // A run whose body waits on a session that ended never settles, so nothing waits for
      // runs: their sessions end, and their hooks are closed.
      await Promise.all(running.values());
      timers.dispose();
      for (const release of releases.splice(0)) release();
    },
  };
}
