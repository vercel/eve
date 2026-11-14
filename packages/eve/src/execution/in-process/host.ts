import type {
  DeliverHookPayload,
  Runtime,
  SessionCommand,
  SessionCommandResult,
} from "#channel/types.js";
import { agentSessionsOver } from "#execution/agent-sessions/sessions-over.js";
import { remoteChildBindingName } from "#execution/child-binding-name.js";
import type { StartWorkflowToolRun } from "#execution/tools/workflow/start.js";
import { dispatchCoordinationOn } from "#execution/coordination-dispatch-step.js";
import {
  registerHost,
  resumeRoutedHook,
  resumeRoutedSessionInbox,
  type DurableHost,
  type SignInCallbacks,
} from "#execution/hosts.js";
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
import type { SessionHost, StartedSession } from "#execution/session/program.js";
import type { SessionInboxHandle } from "#execution/session-inbox/inbox.js";
import { turnStepOn, type SessionStepHost } from "#execution/session/turn-step.js";
import { createInProcessToolStubs } from "#execution/in-process/tool-stubs.js";
import { applyRunMessagesOn } from "#execution/tools/workflow/apply-run-messages.js";
import { isHookNotFound } from "#shared/run-errors.js";
import { createUlid } from "#shared/ulid.js";
import {
  createMemoryInboxRegistry,
  type DeliveryTiming,
  type MemoryInboxRegistry,
} from "./inbox-transport.js";
import { createMemoryLineStore, type MemoryLineStore } from "./line-store.js";
import { createInProcessRuns, type InProcessRuns } from "./runs.js";
import type { InProcessRuntime } from "./runtime.js";
import type { HostedSession } from "./session-record.js";
import { stoppableStore, type SessionStore } from "./session-store.js";
import { createWorldSessionStore, type WorldSessionStore } from "./world-store.js";
import { memoryWorld } from "#execution/world/memory-world.js";
import type { RuntimeWorld } from "#execution/world/runtime-world.js";
import { createStepAttempts, type StepFaults } from "./step-attempts.js";
import { acrossStepBoundary, structuredCloneBoundary, type StepBoundary } from "./step-boundary.js";
import { createInProcessTimers, type InProcessTimers } from "./timers.js";

// What every runtime of one in-process host shares: its streams, addresses, timers and runs, the
// World its sessions are kept on, the sessions running on any of its runtimes, and the route that
// sends hook tokens it holds here instead of to Workflow. A run's child sessions run on the host's
// runtime for the child's agent (`runtimeFor`), beside the parent's. Sessions survive the process
// only on a World the host was given (`InProcessHostOptions.world`).

export const IN_PROCESS_DEPLOYMENT_ID = "in-process";

/** Whether `settled` has settled by the next macrotask. */
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

/**
 * Delivers to an address wherever it's held: a sign-in callback to its asker, where an asker
 * that's gone isn't an error, as on Workflow.
 */
const deliverRouted: DurableHost["deliver"] = async (to, payload) => {
  if ("hook" in to) return await resumeRoutedHook(to.hook, payload);
  if ("session" in to)
    return await resumeRoutedSessionInbox(to.session, payload as DeliverHookPayload);
  try {
    await resumeRoutedHook(to.signIn, payload);
  } catch (error) {
    if (!isHookNotFound(error)) throw error;
  }
};

export interface InProcessHostOptions {
  /**
   * The World each session is kept on as it runs: its lines and accepted inputs as they arrive,
   * the rest at every step boundary, so another runtime on the same World continues it after a
   * crash. Given one, disposing the runtime suspends its sessions instead of ending them.
   * Without one, sessions are kept on a World in this process's memory, and end with the
   * runtime.
   */
  readonly world?: RuntimeWorld;
  /**
   * How a step's data and a hook's payload cross between their sides. A structured clone by
   * default; a test that needs a deployment's exact serializer passes Workflow's
   * (`workflow-host/step-boundary.ts`), which this module never loads itself.
   */
  readonly stepBoundary?: StepBoundary;
  /**
   * The base URL sign-in callbacks reach its sessions at. Without it, a session can't call a
   * sign-in back, as a Workflow session outside a run can't.
   */
  readonly callbackBaseUrl?: string;
  /**
   * @internal Turn steps that lose their completion, or fail, and run again, as on Workflow.
   * Only the test hosts in `internal/testing` pass it; production hosts have no faults.
   */
  readonly stepFaults?: StepFaults;
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
  /** The actor whose activation this host runs in, which its runs' ids name (`InProcessRunsHost.owner`). */
  readonly runOwner?: string;
  /**
   * @internal Where sessions' streams are held: a test that restarts its host on one World
   * passes the same store to each, so its readers follow a session across the restart. A host
   * that suspends detaches its streams (`MemoryLineStore.detachAll`), and the next host's
   * restore reopens each from what the World kept.
   */
  readonly lineStore?: MemoryLineStore;
  /** How long disposing waits for running turns to park before it resets their sessions: 5s. */
  readonly disposeGraceMs?: number;
  /**
   * When sessions and runs read what's delivered, and a session the end of its turn step
   * (`DeliveryTiming`); at once by default.
   */
  readonly deliveries?: DeliveryTiming;
}

/** A session running here: what the host records of it, and its loop. */
export interface LiveSession {
  readonly record: HostedSession;
  readonly loop: StartedSession;
}

export interface InProcessHost {
  readonly deploymentId: string;
  readonly lines: MemoryLineStore;
  readonly inboxes: MemoryInboxRegistry;
  readonly timers: InProcessTimers;
  readonly runs: InProcessRuns;
  /** The World the host's sessions are kept on. */
  readonly world: RuntimeWorld;
  /** Its sessions on the World, until `dispose` stops writing to it. */
  readonly store: SessionStore;
  /** Whether the host keeps its sessions for another runtime: it was given a World. */
  readonly keeps: boolean;
  /** Whether readers here read its sessions from its memory (`InProcessHostOptions.servesLines`). */
  readonly servesLines: boolean;
  /** The record of each session as it boots and runs here, by session id. */
  readonly records: Map<string, HostedSession>;
  /** Each session's loop, once it runs. */
  readonly sessions: Map<string, LiveSession>;
  /** How many waits on its inbox each session's loop is in now; see `InProcessRuntime.activity`. */
  readonly parked: Map<string, number>;
  /** Each running session's inbox, as its loop reads it. */
  readonly readers: Map<string, SessionInboxHandle>;
  /** Restores in flight, by session id. */
  readonly restoring: Map<string, Promise<{ readonly sessionId: string }>>;
  /** Each running session's end. */
  readonly running: Map<string, Promise<void>>;
  /** The host a session's loop runs on, which `recorder` keeps. */
  sessionHost(recorder: HostedSession): SessionHost;
  /**
   * Whether the host suspended its sessions: it was disposed with a World keeping them, so they
   * stop without ending (`SessionRecorder.suspended`).
   */
  suspended(): boolean;
  /** How many of `sessionId`'s turn steps are running now. */
  stepsRunning(sessionId: string): number;
  /** Counts `work` as in flight here until it settles; see {@link InProcessHost.idle}. */
  working<T>(work: () => Promise<T>): Promise<T>;
  /**
   * Resolves once nothing here is working: no delivery, step or session start is in flight, so
   * every session and run waits on a message, a person or a timer.
   */
  idle(): Promise<void>;
  /** Whether a delivery, step or session start is in flight here now. */
  busy(): boolean;
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
  /** How many deliveries were made here so far. */
  deliveries(): number;
  /** Delivers a command to the session holding `token`. */
  deliverCommand<TCommand extends SessionCommand>(
    token: string,
    command: TCommand,
  ): Promise<SessionCommandResult<TCommand>>;
  /** Releases `release` when the host is disposed. */
  onDispose(release: () => void): void;
  /**
   * Stops serving: suspends the sessions a given World keeps, unless `suspend` is `false`, and
   * ends the rest, then waits for each session's loop to stop.
   */
  dispose(options?: { readonly suspend?: boolean }): Promise<void>;
}

/**
 * The host every runtime `runtimeFor` returns shares. It reaches a child's runtime through
 * `runtimeFor`, which also reopens a child a run opened before a restore.
 */
export function createInProcessHost(
  options: InProcessHostOptions,
  runtimeFor: (config: SessionRuntimeConfig) => InProcessRuntime,
): InProcessHost {
  const lines = options.lineStore ?? createMemoryLineStore();
  const stepBoundary = options.stepBoundary ?? structuredCloneBoundary;
  const work = createWorkCounter();
  let deliveries = 0;
  const registry = createMemoryInboxRegistry(stepBoundary, {
    ...(options.deliveries !== undefined && { deliveries: options.deliveries }),
  });
  const inboxes: MemoryInboxRegistry = {
    ...registry,
    deliver: (token, payload) => {
      deliveries += 1;
      return work.count(() => registry.deliver(token, payload));
    },
  };
  const timers: InProcessTimers = createInProcessTimers();
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
  const restoring = new Map<string, Promise<{ readonly sessionId: string }>>();
  let suspending = false;
  // Once draining, a step that would start waits for `dispose`, which refuses it.
  let draining: Promise<never> | undefined;
  let refuseDrained: (error: Error) => void = () => {};
  // Children a restored run is reopening: until each claims its addresses, what arrives for it
  // finds no one, so the host isn't quiescent.
  let reopening = 0;
  /** How many of each session's waits are on a timer (`SessionHost.until`). */
  const sleeping = new Map<string, number>();
  const untilFor = (sessionId: string) => async (at: number) => {
    sleeping.set(sessionId, (sleeping.get(sessionId) ?? 0) + 1);
    try {
      await timers.until(at);
    } finally {
      const left = (sleeping.get(sessionId) ?? 1) - 1;
      if (left === 0) sleeping.delete(sessionId);
      else sleeping.set(sessionId, left);
    }
  };
  const running = new Map<string, Promise<void>>();
  const steps = new Map<string, number>();
  const releases: (() => void)[] = [];
  const toolStubs = createInProcessToolStubs();
  const attempts = createStepAttempts(options.stepFaults);

  const deliverCommand: InProcessHost["deliverCommand"] = async (token, command) => {
    const identified = identifyCommand(command);
    const delivery = await inboxes.deliver(token, identified);
    if (delivery?.kind !== "delivered") return inactiveCommandResult(identified);
    // A reset answers once the session let go of its addresses, as Workflow's does, so a message
    // sent after it starts the next session instead of reaching the one that's ending.
    if (identified.kind === "reset") await addressesReleased(inboxes, delivery.owner);
    return activeCommandResult(identified, delivery.owner);
  };
  const dispatchSession: Runtime["dispatchSession"] = async ({ command, sessionId }) =>
    await deliverCommand(sessionCommandHookToken(sessionId), command);

  const runs = createInProcessRuns({
    dispatchSession,
    suspending: () => suspending,
    ...(options.runOwner !== undefined && { owner: options.runOwner }),
    ...(options.startDurableRun !== undefined && { startDurableRun: options.startDurableRun }),
    inboxes,
    async reopenSession(config, sessionId, { idle }) {
      if (sessions.has(sessionId)) return true;
      const inFlight = restoring.get(sessionId);
      if (inFlight !== undefined) return await inFlight.then(() => true);
      reopening += 1;
      try {
        const saved = await store.load(sessionId);
        if (saved === undefined) return false;
        // Between turns, with nothing unread, it has no turn left to reply from.
        if (!idle && saved.open === undefined && (saved.inputs?.unread.length ?? 0) === 0)
          return false;
        await runtimeFor(config).restore(saved);
        return true;
      } finally {
        reopening -= 1;
      }
    },
    runtimeFor,
    stepBoundary,
    timers,
    toolStubs,
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

  const signInCallbacks: SignInCallbacks | undefined =
    options.callbackBaseUrl === undefined
      ? undefined
      : { callbackBaseUrl: options.callbackBaseUrl.replace(/\/$/, ""), deliver: deliverRouted };
  const stepHost: SessionStepHost = {
    createRuntime: () => options.stepRuntime?.() ?? NO_STEP_RUNTIME,
    // Attributes belong to a Workflow run; an in-process session has none.
    setAttributes: async () => {},
    toolStubs,
    ...signInCallbacks,
  };
  const runTurnStep = turnStepOn(stepHost);

  const applyRunMessages = applyRunMessagesOn({
    // Where a remote child streams from, beside the parent's state on its World.
    recordRemoteBinding: async (parentSessionId, binding) => {
      if (options.worldStore === undefined) unavailable("A remote agent");
      await options.worldStore.keep(
        parentSessionId,
        remoteChildBindingName(binding.childSessionId),
        binding,
      );
    },
    stopLate,
  });
  const dispatchRuns = dispatchCoordinationOn(runs.startRun);
  const sessionHost: Omit<SessionHost, "recorder" | "until"> = {
    toolStubs,
    applyRunMessages: (input) => work.count(() => applyRunMessages(input)),
    dispatchRuns: (input) => work.count(() => dispatchRuns(input)),
    /**
     * One turn step, whose data crosses the host's step boundary each way as it would a
     * deployment's serializer. Its stream and signals are services, which cross as they are.
     */
    runTurnStep: (input) =>
      work.count(async () => {
        if (draining !== undefined) await draining;
        const { abortSignal, sessionWritable, steeringSignal, ...data } = input;
        const { sessionId } = input.sessionState;
        steps.set(sessionId, (steps.get(sessionId) ?? 0) + 1);
        try {
          // Each attempt receives its own copy of the input and its own writable, as each of a
          // Workflow step's does.
          const result = await attempts.run(
            {
              name: "turnStep",
              sessionId,
              ...(abortSignal !== undefined && { signal: abortSignal }),
            },
            async (attempt) => ({
              ...(await acrossStepBoundary(stepBoundary, data)),
              abortSignal,
              sessionWritable: attempts.writable(attempt, sessionWritable),
              steeringSignal,
            }),
            runTurnStep,
          );
          return await acrossStepBoundary(stepBoundary, result);
        } finally {
          const left = (steps.get(sessionId) ?? 1) - 1;
          if (left === 0) steps.delete(sessionId);
          else steps.set(sessionId, left);
          // On Workflow, a session reads a step's end when its run next replays, with every hook
          // payload that arrived by then. With batched deliveries, so does this one.
          await inboxes.heard();
        }
      }),
  };

  releases.push(
    registerHost({
      async deliver(token, payload) {
        // A session's addresses are named here by their logical tokens; a sign-in callback's URL
        // carries the physical one (`eve:inbox:...`).
        const address = logicalSessionInboxToken(token) ?? token;
        // A suspended host's sessions are the World's now, not gone: whoever continues them
        // answers for their addresses. Its runs' hooks still take what its sessions send them as
        // they stop, such as a cancelled call's end.
        if (
          suspending &&
          (inboxes.holdsForSession(address) || inboxes.holder(address) === undefined)
        )
          return undefined;
        const delivery = await inboxes.deliver(address, payload);
        return delivery?.kind;
      },
      runEnded: (runId) => (suspending ? undefined : runs.runEnded(runId)),
      cancelRun: (runId, reason) => (suspending ? undefined : runs.cancelRun(runId, reason)),
      stepAttempt: () => attempts.current(),
      // A session's steps outside its turn steps, such as relaying a child's sign-in, call back.
      signInCallbacks: (sessionId) => (running.has(sessionId) ? signInCallbacks : undefined),
    }),
  );

  return {
    deliverCommand,
    deploymentId: IN_PROCESS_DEPLOYMENT_ID,
    inboxes,
    keeps: kept !== undefined,
    lines,
    records,
    restoring,
    parked: new Map(),
    readers: new Map(),
    runs,
    running,
    sessions,
    store,
    timers,
    world,
    servesLines: options.servesLines ?? true,
    sessionHost: (recorder) => ({ ...sessionHost, recorder, until: untilFor(recorder.sessionId) }),
    suspended: () => suspending,
    stepsRunning: (sessionId) => steps.get(sessionId) ?? 0,
    working: (counted) => work.count(counted),
    idle: () => work.idle(),
    busy: () => work.inFlight() > 0,
    async quiescent() {
      if (reopening > 0 || work.inFlight() > 0 || !inboxes.quiet()) return false;
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
    deliveries: () => deliveries,
    onDispose(release) {
      releases.push(release);
    },
    async dispose(disposeOptions) {
      if (kept !== undefined && disposeOptions?.suspend !== false) return await suspend();
      refuseDrained(new Error("The host stopped before this step started."));
      // Runs end first, while their sessions still listen, so each session hears its runs' ends
      // instead of waiting out a run that can no longer reach it.
      await runs.stopAll("The in-process host is stopping.");
      // A turn still running gets a grace to park, as a server's shutdown gives its requests.
      // One that never does, such as a turn whose runs ended and that keeps calling its model, is
      // reset: closing its addresses wouldn't stop it.
      if (!(await restsWithin(work, options.disposeGraceMs ?? DISPOSE_GRACE_MS))) {
        await Promise.all(
          [...running.keys()].map((sessionId) =>
            registry
              .deliver(
                sessionCommandHookToken(sessionId),
                identifyCommand({ deliveryId: `in-process-dispose:${sessionId}`, kind: "reset" }),
              )
              .catch(() => {}),
          ),
        );
      }
      inboxes.closeAll();
      await Promise.all(running.values());
      timers.dispose();
      for (const release of releases.splice(0)) release();
    },
  };

  /**
   * Disposing a host given a World: its sessions are suspended, not ended. The World holds them
   * as they were, and closing their addresses stops their loops without ending them, so
   * `restore` continues each with its sandbox, its children and its runs, as after a crash.
   */
  async function suspend(): Promise<void> {
    suspending = true;
    // What sessions wrote is kept before the World stops being written to, so a suspended
    // session's stream holds every line it wrote.
    await lines.flushAll().catch(() => {});
    kept?.stop();
    lines.detachAll();
    refuseDrained(new Error("The host stopped before this step started."));
    // Closing its addresses stops each loop where it waits next; a turn still running goes on
    // to its next wait, writing nothing the World keeps, and a restore runs its cut-off step
    // again.
    inboxes.closeAll();
    // A run whose body waits on a session that stopped never settles, so nothing waits for runs:
    // their hooks are closed, and a restore runs them again or reports them interrupted.
    await Promise.all(running.values());
    timers.dispose();
    for (const release of releases.splice(0)) release();
  }
}

/** How long disposing waits for running turns to park before it resets their sessions. */
const DISPOSE_GRACE_MS = 5_000;

/** Whether the host comes to rest within `ms`. */
async function restsWithin(
  work: ReturnType<typeof createWorkCounter>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.idle().then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Work in flight on a host, and a wait for none to be. */
function createWorkCounter() {
  let inFlight = 0;
  const waiters = new Set<() => void>();
  return {
    inFlight: () => inFlight,
    async count<T>(work: () => Promise<T>): Promise<T> {
      inFlight += 1;
      try {
        return await work();
      } finally {
        inFlight -= 1;
        if (inFlight === 0) {
          for (const resolve of waiters) resolve();
          waiters.clear();
        }
      }
    },
    async idle(): Promise<void> {
      // Rest must hold across macrotasks: what settled work starts next is in flight by then.
      for (let quiet = 0; quiet < 3;) {
        if (inFlight > 0) {
          quiet = 0;
          await new Promise<void>((resolve) => waiters.add(resolve));
        }
        await new Promise((resolve) => setImmediate(resolve));
        quiet = inFlight === 0 ? quiet + 1 : 0;
      }
    },
  };
}

/** How long a reset waits for its session's addresses, as Workflow's ingress does. */
const RESET_RELEASE_TIMEOUT_MS = 30_000;

/**
 * Resolves once `owner` holds no address, as Workflow's reset waits for the session's hooks
 * (`waitForSessionHooksRelease`): before the session finishes ending, so a successor can start
 * while the old one still writes its end. One that never lets go fails instead of hanging.
 */
async function addressesReleased(inboxes: MemoryInboxRegistry, owner: string): Promise<void> {
  const deadline = Date.now() + RESET_RELEASE_TIMEOUT_MS;
  while (inboxes.holdsAny(owner)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for session "${owner}" to release its addresses.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
