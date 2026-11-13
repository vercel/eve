import type {
  DeliverHookPayload,
  Runtime,
  SessionCommand,
  SessionCommandResult,
} from "#channel/types.js";
import { agentSessionsOver } from "#execution/agent-sessions/sessions-over.js";
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
import type { SessionHost } from "#execution/session/program.js";
import { turnStepOn, type SessionStepHost } from "#execution/session/turn-step.js";
import { createInProcessToolStubs } from "#execution/in-process/tool-stubs.js";
import { applyRunMessagesOn } from "#execution/tools/workflow/apply-run-messages.js";
import { isHookNotFound } from "#shared/run-errors.js";
import { createUlid } from "#shared/ulid.js";
import { createMemoryInboxRegistry, type MemoryInboxRegistry } from "./inbox-transport.js";
import { createMemoryLineStore, type MemoryLineStore } from "./line-store.js";
import { createInProcessRuns, type InProcessRuns } from "./runs.js";
import { createStepAttempts, type StepFaults } from "./step-attempts.js";
import { acrossStepBoundary, structuredCloneBoundary, type StepBoundary } from "./step-boundary.js";
import { createInProcessTimers, type InProcessTimers } from "./timers.js";

// What every runtime of one in-process host shares: its streams, addresses, timers and runs, the
// sessions running on any of its runtimes, and the route that sends hook tokens it holds here
// instead of to Workflow. A run's child sessions run on the host's runtime for the child's agent
// (`runtimeFor`), beside the parent's. Nothing here survives the process.

export const IN_PROCESS_DEPLOYMENT_ID = "in-process";

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
  /** For tests: turn steps that lose their completion, or fail, and run again, as on Workflow. */
  readonly stepFaults?: StepFaults;
}

export interface InProcessHost {
  readonly deploymentId: string;
  readonly lines: MemoryLineStore;
  readonly inboxes: MemoryInboxRegistry;
  readonly runs: InProcessRuns;
  /** Each running session's end. */
  readonly running: Map<string, Promise<void>>;
  /** The host a session's loop runs on. */
  readonly sessionHost: SessionHost;
  /** How many of `sessionId`'s turn steps are running now. */
  stepsRunning(sessionId: string): number;
  /** Counts `work` as in flight here until it settles; see {@link InProcessHost.idle}. */
  working<T>(work: () => Promise<T>): Promise<T>;
  /**
   * Resolves once nothing here is working: no delivery, step or session start is in flight, so
   * every session and run waits on a message, a person or a timer.
   */
  idle(): Promise<void>;
  /** Delivers a command to the session holding `token`. */
  deliverCommand<TCommand extends SessionCommand>(
    token: string,
    command: TCommand,
  ): Promise<SessionCommandResult<TCommand>>;
  /** Releases `release` when the host is disposed. */
  onDispose(release: () => void): void;
  /** Stops serving: closes every address, and waits for each session to end. */
  dispose(): Promise<void>;
}

/** The host every runtime `runtimeFor` returns shares. */
export function createInProcessHost(
  options: InProcessHostOptions,
  runtimeFor: (config: SessionRuntimeConfig) => Runtime,
): InProcessHost {
  const lines = createMemoryLineStore();
  const stepBoundary = options.stepBoundary ?? structuredCloneBoundary;
  const work = createWorkCounter();
  const registry = createMemoryInboxRegistry(stepBoundary);
  const inboxes: MemoryInboxRegistry = {
    ...registry,
    deliver: (token, payload) => work.count(() => registry.deliver(token, payload)),
  };
  const timers: InProcessTimers = createInProcessTimers();
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
    inboxes,
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
    createRuntime: () => NO_STEP_RUNTIME,
    // Attributes belong to a Workflow run; an in-process session has none.
    setAttributes: async () => {},
    toolStubs,
    ...signInCallbacks,
  };
  const runTurnStep = turnStepOn(stepHost);

  const applyRunMessages = applyRunMessagesOn({
    // A remote child can't be opened here, so no run reports one.
    recordRemoteBinding: async () => unavailable("A remote agent"),
    stopLate,
  });
  const dispatchRuns = dispatchCoordinationOn(runs.startRun);
  const sessionHost: SessionHost = {
    toolStubs,
    applyRunMessages: (input) => work.count(() => applyRunMessages(input)),
    dispatchRuns: (input) => work.count(() => dispatchRuns(input)),
    /**
     * One turn step, whose data crosses the host's step boundary each way as it would a
     * deployment's serializer. Its stream and signals are services, which cross as they are.
     */
    runTurnStep: (input) =>
      work.count(async () => {
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
        }
      }),
    until: (at) => timers.until(at),
  };

  releases.push(
    registerHost({
      async deliver(token, payload) {
        // A session's addresses are named here by their logical tokens; a sign-in callback's URL
        // carries the physical one (`eve:inbox:...`).
        const delivery = await inboxes.deliver(logicalSessionInboxToken(token) ?? token, payload);
        return delivery?.kind;
      },
      runEnded: (runId) => runs.runEnded(runId),
      cancelRun: (runId, reason) => runs.cancelRun(runId, reason),
      stepAttempt: () => attempts.current(),
      // A session's steps outside its turn steps, such as relaying a child's sign-in, call back.
      signInCallbacks: (sessionId) => (running.has(sessionId) ? signInCallbacks : undefined),
    }),
  );

  return {
    deliverCommand,
    deploymentId: IN_PROCESS_DEPLOYMENT_ID,
    inboxes,
    lines,
    runs,
    running,
    sessionHost,
    stepsRunning: (sessionId) => steps.get(sessionId) ?? 0,
    working: (counted) => work.count(counted),
    idle: () => work.idle(),
    onDispose(release) {
      releases.push(release);
    },
    async dispose() {
      // Runs end first, while their sessions still listen, so each session hears its runs' ends
      // instead of waiting out a run that can no longer reach it.
      await runs.stopAll("The in-process host is stopping.");
      // A session in a turn ends it, as a reset does: with its runs gone, a turn that keeps
      // calling its model would never park, and closing its addresses wouldn't stop it.
      await Promise.all(
        [...running.keys()].map((sessionId) =>
          inboxes
            .deliver(
              sessionCommandHookToken(sessionId),
              identifyCommand({ deliveryId: `in-process-dispose:${sessionId}`, kind: "reset" }),
            )
            .catch(() => {}),
        ),
      );
      inboxes.closeAll();
      await Promise.all(running.values());
      timers.dispose();
      for (const release of releases.splice(0)) release();
    },
  };
}

/** Work in flight on a host, and a wait for none to be. */
function createWorkCounter() {
  let inFlight = 0;
  const waiters = new Set<() => void>();
  return {
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
