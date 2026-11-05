import type { Runtime, SessionCommand, SessionCommandResult } from "#channel/types.js";
import { dispatchCoordinationOn } from "#execution/coordination-dispatch-step.js";
import {
  activeCommandResult,
  identifyCommand,
  inactiveCommandResult,
} from "#execution/session-commands.js";
import type { SessionHost, SessionMoves, StartedSession } from "#execution/session/program.js";
import { turnStepOn, type SessionStepHost } from "#execution/session/turn-step.js";
import { applyRunMessagesOn } from "#execution/tools/workflow/apply-run-messages.js";
import { createMemoryInboxRegistry, type MemoryInboxRegistry } from "./inbox-transport.js";
import { createMemoryLineStore } from "./line-store.js";
import type { HostedSession } from "./session-record.js";
import { memoryWorld } from "#execution/world/memory-world.js";
import type { RuntimeWorld } from "#execution/world/runtime-world.js";
import { stoppableStore, type SessionStore } from "./session-store.js";
import { createWorldSessionStore } from "./world-store.js";
import { acrossStepBoundary, structuredCloneBoundary, type StepBoundary } from "./step-boundary.js";
import { createInProcessTimers, type InProcessTimers } from "./timers.js";

// What an in-process host keeps for the sessions it runs: its stores, addresses and timers, and
// the sessions running on it.

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

function unavailable(what: string): never {
  throw new Error(
    `${what} needs a durable run, which an in-process session doesn't have. Run the agent with \`eve dev\` or deploy it.`,
  );
}

/** The runtime a session's durable calls would start in, which refuses each. */
const NO_DURABLE_RUNS: Runtime = {
  createSession: async () => unavailable("Starting a subagent or task session"),
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
   * What a step's data crosses: a structured clone by default. Workflow's serializer
   * (`workflowStepBoundary`) hands steps exactly what a deployment would.
   */
  readonly stepBoundary?: StepBoundary;
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
  /** The World the host's sessions are runs on. */
  readonly world: RuntimeWorld;
  /** Its sessions on the World, until `dispose` stops writing to it. */
  readonly store: SessionStore;
  /** Whether the host keeps its sessions for another runtime: it was given a World. */
  readonly keeps: boolean;
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
  /** Releases `release` when the host is disposed. */
  onDispose(release: () => void): void;
  /** Stops serving: suspends the sessions a store keeps, and ends the rest. */
  dispose(): Promise<void>;
}

export function createInProcessHost(options: InProcessHostOptions): InProcessHost {
  const lines = createMemoryLineStore();
  const stepBoundary = options.stepBoundary ?? structuredCloneBoundary;
  const inboxes = createMemoryInboxRegistry();
  const timers = createInProcessTimers();
  const world = options.world ?? memoryWorld();
  const onWorld = createWorldSessionStore(world, {
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

  const deliverCommand: InProcessHost["deliverCommand"] = async (token, command) => {
    const identified = identifyCommand(command);
    // Kept before its address accepts it, so a session that goes on after a crash has it.
    const holder = inboxes.holder(token);
    if (holder !== undefined) await records.get(holder)?.accept(token, identified);
    const held = inboxes.deliver(token, identified);
    return held === undefined
      ? inactiveCommandResult(identified)
      : activeCommandResult(identified, held.sessionId);
  };

  // Without runs, no run sends anything.
  const applyRunMessages = applyRunMessagesOn({
    recordRemoteBinding: async () => unavailable("A remote agent"),
    stopLate: async () => unavailable("A subagent"),
  });
  // Each call that needs a run of its own fails with why, as a run that can't start does.
  const dispatchRuns = dispatchCoordinationOn(async ({ toolName }) =>
    unavailable(`The \`${toolName}\` tool`),
  );

  const stepHost: SessionStepHost = {
    createRuntime: () => NO_DURABLE_RUNS,
    // Attributes belong to a Workflow run; an in-process session has none.
    setAttributes: async () => {},
  };
  const runTurnStep = turnStepOn(stepHost);
  /**
   * One turn step, whose data crosses the host's step boundary each way as it would a
   * deployment's serializer. Its stream and signals are services, which cross as they are.
   */
  const runTurnStepAcrossBoundary: SessionHost["runTurnStep"] = async (input) => {
    const { abortSignal, sessionWritable, steeringSignal, ...data } = input;
    const crossed = await acrossStepBoundary(stepBoundary, data);
    return await acrossStepBoundary(
      stepBoundary,
      await runTurnStep({ ...crossed, abortSignal, sessionWritable, steeringSignal }),
    );
  };

  return {
    deliverCommand,
    deploymentId: IN_PROCESS_DEPLOYMENT_ID,
    inboxes,
    lines,
    records,
    running,
    sessions,
    keeps: kept !== undefined,
    store,
    timers,
    world,
    sessionHost: (recorder) => ({
      applyRunMessages,
      dispatchRuns,
      moves: IN_PROCESS_MOVES,
      recorder,
      runTurnStep: runTurnStepAcrossBoundary,
      sleep: (ms) => timers.until(Date.now() + ms),
    }),
    suspended: () => suspending,
    onDispose(release) {
      releases.push(release);
    },
    async dispose() {
      // Sessions on a World the runtime was given are suspended: the World holds them as they
      // were, and closing their addresses stops their loops without ending them, so restore
      // continues them with their sandboxes, as after a crash. Otherwise, closing ends them.
      suspending = kept !== undefined;
      // What sessions wrote is kept before the World stops being written to, so a suspended
      // session's stream holds every line it wrote.
      if (kept !== undefined) await lines.flushAll().catch(() => {});
      kept?.stop();
      inboxes.closeAll();
      await Promise.all(running.values());
      timers.dispose();
      for (const release of releases.splice(0)) release();
    },
  };
}
