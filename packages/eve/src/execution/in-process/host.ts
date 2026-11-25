import { builtInHosts, type App } from "#runtime/app.js";
import { createLifetime } from "#runtime/lifetime.js";
import type { Entities } from "#platform/entities.js";
import type {
  DeliverHookPayload,
  Runtime,
  SessionCommand,
  SessionCommandResult,
} from "#channel/types.js";
import { agentSessionsOver } from "#execution/agent-sessions/sessions-over.js";
import { dispatchCoordinationOn } from "#execution/coordination-dispatch-step.js";
import {
  decodeDeliveryAddress,
  readStreamLines,
  reveal,
  type Durable,
  type SessionStartResult,
} from "#execution/durable.js";
import {
  registerHostedRoute,
  resumeRoutedHook,
  registerSessionEventStore,
  resumeRoutedSessionInbox,
  type AppHosts,
  type RouteHosts,
  type ResumeAddress,
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
  logicalSessionToken,
  sessionCommandHookToken,
} from "#execution/session-inbox/address.js";
import type { InitialWorkflowEntryInput } from "#execution/session/entry-input.js";
import { bootInitialOwner } from "#execution/session/owner-boot.js";
import { runPreparedSession, type ProgramHost } from "#execution/session/program.js";
import type { SessionStartBody } from "#execution/session-runtime.js";
import { SHARED_SESSION_STEPS } from "#execution/session/shared-steps.js";
import { sessionHostClock, settleAll } from "#execution/session/host-clock.js";
import type { SessionInboxHandle } from "#execution/session-inbox/inbox.js";
import { dispatchSessionSteps, type SessionStepCall } from "#execution/session/steps.js";
import { turnStepOn, type SessionStepHost } from "#execution/session/turn-step.js";
import { createInProcessToolStubs } from "#execution/in-process/tool-stubs.js";
import type { ToolStubHost } from "#execution/tool-stub-host.js";
import { applyRunMessagesOn } from "#execution/tools/workflow/apply-run-messages.js";
import { HookNotFoundError, isHookNotFound } from "#shared/run-errors.js";
import { createUlid } from "#shared/ulid.js";
import {
  createMemoryInboxRegistry,
  type DeliveryTiming,
  type MemoryInboxRegistry,
} from "./inbox-transport.js";
import {
  createMemorySessionEventStore,
  type MemorySessionEventStore,
} from "./session-event-store.js";
import { createInProcessRuns, type InProcessRuns } from "./runs.js";
import { createStepAttempts, type StepFaults } from "./step-attempts.js";
import { acrossStepBoundary, structuredCloneBoundary, type StepBoundary } from "./step-boundary.js";
import { createInProcessTimers, type InProcessTimers } from "./timers.js";

export const IN_PROCESS_DEPLOYMENT_ID = "in-process";

function unavailable(what: string): never {
  throw new Error(
    `${what} needs a deployment, which an in-process session doesn't have. Run the agent with \`eve dev\` or deploy it.`,
  );
}

const NO_STEP_RUNTIME: Runtime = {
  createSession: async () => unavailable("Starting a session from a tool"),
  dispatchContinuation: async () => unavailable("Sending to another session"),
  dispatchSession: async () => unavailable("Sending to another session"),
  getEventStream: async () => unavailable("Reading another session"),
  getLineStream: async () => unavailable("Reading another session"),
  getStreamTailIndex: async () => unavailable("Reading another session"),
  resolveContinuation: async () => unavailable("Resolving another session"),
};

function deliverRoutedOn(hosts: RouteHosts): ResumeAddress {
  return async (to, payload) => {
    const address = decodeDeliveryAddress(to);
    if (address.kind === "hook") return await resumeRoutedHook(hosts, address.token, payload);
    if (address.kind === "session")
      return await resumeRoutedSessionInbox(hosts, address.address, payload as DeliverHookPayload);
    try {
      await resumeRoutedHook(hosts, address.token, payload);
    } catch (error) {
      if (!isHookNotFound(error)) throw error;
    }
  };
}

export interface InProcessHostOptions {
  readonly platform: Entities;
  readonly stepBoundary?: StepBoundary;
  readonly callbackBaseUrl?: string;
  /** @internal */
  readonly stepFaults?: StepFaults;
  readonly disposeGraceMs?: number;
  readonly deliveries?: DeliveryTiming;
}

export interface InProcessHost {
  readonly deploymentId: string;
  readonly hosts: AppHosts;
  readonly lines: MemorySessionEventStore;
  readonly inboxes: MemoryInboxRegistry;
  readonly runs: InProcessRuns;
  readonly running: Map<string, Promise<void>>;
  readonly durable: Durable;
  readonly step: SessionStepCall;
  readonly toolStubs: ToolStubHost;
  startEntry(
    entry: Omit<InitialWorkflowEntryInput, "ownerDeploymentId">,
  ): Promise<SessionStartResult>;
  stepsRunning(sessionId: string): number;
  working<T>(work: () => Promise<T>): Promise<T>;
  idle(): Promise<void>;
  deliverCommand<TCommand extends SessionCommand>(
    token: string,
    command: TCommand,
  ): Promise<SessionCommandResult<TCommand>>;
  onDispose(release: () => void): void;
  dispose(): Promise<void>;
}

export function createInProcessHost(
  options: InProcessHostOptions,
  runtimeFor: (config: SessionRuntimeConfig) => Runtime,
): InProcessHost {
  const hosts = builtInHosts();
  const lines = createMemorySessionEventStore();
  const stepBoundary = options.stepBoundary ?? structuredCloneBoundary;
  const work = createWorkCounter();
  const registry = createMemoryInboxRegistry(stepBoundary, {
    ...(options.deliveries !== undefined && { deliveries: options.deliveries }),
  });
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
    if (identified.kind === "reset") await addressesReleased(inboxes, delivery.owner);
    return activeCommandResult(identified, delivery.owner);
  };
  const dispatchSession: Runtime["dispatchSession"] = async ({ command, sessionId }) =>
    await deliverCommand(sessionCommandHookToken(sessionId), command);

  const runs = createInProcessRuns({
    dispatchSession,
    hosts,
    inboxes,
    runtimeFor,
    stepBoundary,
    timers,
    toolStubs,
  });

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
      : {
          callbackBaseUrl: options.callbackBaseUrl.replace(/\/$/, ""),
          deliver: deliverRoutedOn(hosts),
        };
  const app: App = {
    platform: options.platform,
    hosts,
    get durable(): Durable {
      return durable;
    },
    lifetime: createLifetime(),
  };
  const stepHost: SessionStepHost = {
    app,
    hosts,
    createRuntime: () => NO_STEP_RUNTIME,
    setAttributes: async () => {},
    toolStubs,
    ...signInCallbacks,
  };
  const runTurnStep = turnStepOn(stepHost);

  const applyRunMessages = applyRunMessagesOn(hosts, {
    recordRemoteBinding: async () => unavailable("A remote agent"),
    stopLate,
  });
  const dispatchRuns = dispatchCoordinationOn(hosts, runs.startRun);
  const step = dispatchSessionSteps({
    ...SHARED_SESSION_STEPS,
    applyRunMessages: (input) => work.count(() => applyRunMessages(input)),
    dispatchRuns: (input) => work.count(() => dispatchRuns(input)),
    turn: ({ sessionWritable, ...input }, call) =>
      work.count(async () => {
        const { sessionId } = input.sessionState;
        const { signals } = call;
        steps.set(sessionId, (steps.get(sessionId) ?? 0) + 1);
        try {
          const result = await attempts.run(
            {
              name: "turnStep",
              sessionId,
              ...(signals !== undefined && { signal: signals.cancel }),
            },
            async (attempt) => ({
              data: await acrossStepBoundary(stepBoundary, input),
              meta: {
                attempt: attempt.attempt,
                key: call.key,
                sessionId,
                ...(signals !== undefined && { signals }),
              },
              stream: attempts.writable(attempt, sessionWritable),
            }),
            ({ data, meta, stream }) => runTurnStep({ ...data, sessionWritable: stream }, meta),
          );
          return await acrossStepBoundary(stepBoundary, result);
        } finally {
          const left = (steps.get(sessionId) ?? 1) - 1;
          if (left === 0) steps.delete(sessionId);
          else steps.set(sessionId, left);
          await inboxes.heard();
        }
      }),
  });
  const programHostFor = (inbox: SessionInboxHandle): ProgramHost => ({
    ...sessionHostClock(inbox, (at) => timers.until(at)),
    step,
    toolStubs,
  });

  const tokenOf = (to: Parameters<Durable["deliver"]>[0]): string => {
    const address = decodeDeliveryAddress(to);
    return address.kind === "session" ? logicalSessionToken(address.address) : address.token;
  };
  const known = (sessionId: string): boolean =>
    running.has(sessionId) || lines.sessions().includes(sessionId);
  const bootEntry = async (
    entry: Omit<InitialWorkflowEntryInput, "ownerDeploymentId">,
    wanted?: string,
  ): Promise<SessionStartResult> => {
    if (wanted !== undefined && known(wanted)) return { kind: "started", sessionId: wanted };
    const sessionId = wanted ?? `session_${createUlid()}`;
    const sessionWritable = lines.open(sessionId);
    releases.push(registerSessionEventStore(hosts, sessionId, lines));
    const boot = await bootInitialOwner(
      { ...entry, ownerDeploymentId: IN_PROCESS_DEPLOYMENT_ID },
      sessionId,
      {
        inboxTransport: inboxes.transportFor(sessionId),
        sessionWritable,
        step,
        all: settleAll,
        timeouts: () => undefined,
        settleContinuationConflict: async () => {},
      },
    );
    if (boot === undefined) return { kind: "held" };
    const session = runPreparedSession(boot.session, boot.inbox, programHostFor(boot.inbox)).then(
      () => undefined,
      () => undefined,
    );
    running.set(sessionId, session);
    void session.finally(() => running.delete(sessionId));
    return { kind: "started", sessionId };
  };
  const startEntry: InProcessHost["startEntry"] = (entry) => work.count(() => bootEntry(entry));
  const durable: Durable = {
    start: (session) =>
      work.count(() => bootEntry(reveal<SessionStartBody>(session.body).entry, session.sessionId)),
    async deliver(to, payload) {
      const token = tokenOf(to);
      const delivery = await inboxes.deliver(token, payload);
      if (delivery?.kind !== "delivered")
        return { accepted: false, reason: "inactive", cause: new HookNotFoundError(token) };
      if ((payload as { readonly kind?: unknown }).kind === "reset")
        await addressesReleased(inboxes, delivery.owner);
      return { accepted: true, sessionId: delivery.owner };
    },
    sessionFor: async (to) => inboxes.holder(tokenOf(to)),
    readStream: (sessionId, from) => readStreamLines(lines.readable(sessionId, from), from),
    tail: (sessionId) => lines.tail(sessionId),
    status: async (sessionId) =>
      running.has(sessionId) ? "running" : known(sessionId) ? "ended" : undefined,
  };

  releases.push(
    registerHostedRoute(hosts, {
      async deliver(token, payload) {
        const delivery = await inboxes.deliver(logicalSessionInboxToken(token) ?? token, payload);
        return delivery?.kind;
      },
      runEnded: (runId) => runs.runEnded(runId),
      cancelRun: (runId, reason) => runs.cancelRun(runId, reason),
      stepAttempt: () => attempts.current(),
      signInCallbacks: (sessionId) => (running.has(sessionId) ? signInCallbacks : undefined),
    }),
  );

  return {
    deliverCommand,
    deploymentId: IN_PROCESS_DEPLOYMENT_ID,
    hosts,
    durable,
    startEntry,
    inboxes,
    lines,
    runs,
    running,
    step,
    toolStubs,
    stepsRunning: (sessionId) => steps.get(sessionId) ?? 0,
    working: (counted) => work.count(counted),
    idle: () => work.idle(),
    onDispose(release) {
      releases.push(release);
    },
    async dispose() {
      await runs.stopAll("The in-process host is stopping.");
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
}

const DISPOSE_GRACE_MS = 5_000;

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

const RESET_RELEASE_TIMEOUT_MS = 30_000;

async function addressesReleased(inboxes: MemoryInboxRegistry, owner: string): Promise<void> {
  const deadline = Date.now() + RESET_RELEASE_TIMEOUT_MS;
  while (inboxes.holdsAny(owner)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for session "${owner}" to release its addresses.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
