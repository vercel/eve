import { isTakenOver } from "#execution/actor/actors.js";
import type {
  DispatchContinuationInput,
  DispatchSessionInput,
  RunHandle,
  RunInput,
  Runtime,
  SessionCommand,
  SessionCommandResult,
} from "#channel/types.js";
import { registerSessionLineStore, resumeRoutedHook } from "#execution/hosts.js";
import { prepareInitialEntry, type SessionRuntimeConfig } from "#execution/initial-entry.js";
import {
  readSessionEventHistory,
  readSessionEventStream,
  readSessionRecordHistory,
  readSessionRecords,
  readSessionStreamTailIndex,
} from "#execution/session-event-stream.js";
import {
  logicalSessionInboxToken,
  sessionCommandHookToken,
} from "#execution/session-inbox/address.js";
import { createSessionInbox, type SessionInboxHandle } from "#execution/session-inbox/inbox.js";
import { bootFromCheckpoint } from "#execution/session/checkpoint-boot.js";
import type { InitialWorkflowEntryInput } from "#execution/session/entry-input.js";
import { sessionHookTokens } from "#execution/session/hook-tokens.js";
import { bootInitialOwner } from "#execution/session/owner-boot.js";
import { startPreparedSession, type SessionBoot } from "#execution/session/program.js";
import type { SessionTimeouts } from "#execution/session/timeout-control.js";
import { createLogger } from "#internal/logging.js";
import { createUlid } from "#shared/ulid.js";
import { createInProcessHost, type InProcessHost, type InProcessHostOptions } from "./host.js";
import type { Arrival, Keep } from "./inbox-transport.js";
import { planRestore } from "./restore.js";
import {
  interruptedRunOutcome,
  type InProcessRunRecord,
  type RunSnapshot,
  type WorkflowFunction,
} from "./runs.js";
import { HostedSession } from "./session-record.js";
import { type LoadOptions, saveSnapshot, type StoredSession } from "./session-store.js";
import type { SessionSnapshot } from "./snapshot.js";
import { createInProcessTimeoutControl } from "./timers.js";

// A Runtime whose sessions run in this process: the same session loop, turn steps, and kernel a
// deployment runs, with their addresses, steps, and timers held here (`host.ts`). Each session is
// kept on the runtime's World as it runs (`session-record.ts`, `world-store.ts`), so another
// runtime on that World continues it, a turn a crash cut off going on from its last step. A
// session never moves between owners. Workflow tool runs (subagents, the `agent` tool, tasks,
// workflow tools) run here too (`runs.ts`), and the sessions they open run on this runtime's
// siblings, which share its host.

const log = createLogger("execution.in-process.runtime");

const BARRIER_FACTS = ['"type":"call.started"'];
const barrierDecoder = new TextDecoder();

/**
 * Whether `line` must be kept before its writer goes on: a call's start, which a rerun reads to
 * tell the model the call may have run. The rest of a step's lines are kept by the step's end
 * (`HostedSession.save` flushes them first). A line that merely mentions it is kept early too.
 */
function isBarrierLine(line: Uint8Array): boolean {
  const text = barrierDecoder.decode(line);
  return BARRIER_FACTS.some((fact) => text.includes(fact));
}

export type InProcessRuntimeOptions = InProcessHostOptions;

export interface InProcessRuntime extends Runtime {
  /** Resolves once `sessionId`'s session ends here, or at once for one that isn't running. */
  settled(sessionId: string): Promise<void>;
  /** Whether a session here holds the address `token` names. */
  holds(token: string): boolean;
  /** How many of `sessionId`'s turn steps are running now. */
  stepsRunning(sessionId: string): number;
  /**
   * Without a session: resolves once nothing on its host is working: no delivery, step or
   * session start is in flight, so each session and run waits on a message, a person or a timer.
   * With one: resolves once no step of `sessionId`'s session runs and the loop recorded the last
   * one, or at once for a session that isn't running here.
   */
  idle(sessionId?: string): Promise<void>;
  /**
   * Starts a session from the initial entry Workflow's `workflowEntry` takes, for tests written
   * against it.
   */
  startEntry(
    entry: Omit<InitialWorkflowEntryInput, "ownerDeploymentId">,
    /** The session's id, when its World holds it already (a World host's actor). */
    sessionId?: string,
  ): Promise<{ readonly sessionId: string }>;
  /**
   * A session as another process can restore it, with the runs it hadn't heard the end of. It
   * waits for a running step to return (a model call, or a long tool call); a session waiting
   * for its next message, on a person, or on its runs restores as it was, its turn going on from
   * there. For a session mid-step, read `load(id)`, which holds it at any moment.
   */
  snapshot(sessionId: string): Promise<SessionSnapshot>;
  /**
   * Continues a session from its snapshot, under the snapshot's session id. With the World that
   * kept the sessions its subagents opened, their runs go on; any other run it had reports as
   * interrupted. A snapshot this build can't read is refused, with why.
   */
  restore(
    snapshot: SessionSnapshot,
    options?: {
      /** The runtime's World holds `snapshot` already (`load` read it): it isn't saved again. */
      readonly stored?: boolean;
    },
  ): Promise<{ readonly sessionId: string }>;
  /**
   * The session the runtime's World holds under `sessionId`, as `restore` continues it. With
   * `{ lines: "count" }`, without its stream's lines, for a runtime that doesn't serve them.
   */
  load(sessionId: string, options?: LoadOptions): Promise<SessionSnapshot | undefined>;
  /** The sessions the runtime's World holds, most recently saved first. */
  sessions(): Promise<readonly StoredSession[]>;
  /** Makes an authored workflow tool's body, its `"use workflow"` function's twin, run here. */
  registerWorkflow(workflowId: string, body: WorkflowFunction): void;
  /**
   * Starts a session under `sessionId`, whose run its World may hold already (one another
   * process created, with the session's addresses), as `createSession` starts a new one.
   */
  startSession(sessionId: string, input: RunInput): Promise<RunHandle>;
  /**
   * Whether every session and run of this runtime's host waits on what arrives next or on a
   * timer: stopped now (`dispose`), each continues from its World as it is.
   */
  quiescent(): Promise<boolean>;
  /** Whether a delivery, step or session start is in flight on this runtime's host now. */
  busy(): boolean;
  /** The earliest timer any session or run of this runtime's host waits on, epoch milliseconds. */
  nextTimer(): number | undefined;
  /** Lets running steps finish and starts no other, so `dispose` stops at a step boundary. */
  drain(): Promise<void>;
  /** Whether `sessionId` ran here and ended (not stopped by a suspension). */
  ended(sessionId: string): boolean;
  /**
   * Delivers `payload` to the hook `token` names, physical or logical, as a callback route's
   * resume would: `delivered`, `gone` for one it held once, `undefined` for one it never held.
   */
  deliver(token: string, payload: unknown): Promise<"delivered" | "gone" | undefined>;
  /**
   * @internal What runs on its host now: the sessions whose loops run, and the kind of each run
   * still running. A test that restarts the host restores those sessions.
   */
  activity(): {
    readonly sessions: readonly string[];
    /** The sessions whose loops wait on their inbox now. */
    readonly parked: readonly string[];
    /** Whether a delivery, step or session start is in flight now. */
    readonly working: boolean;
    /** How many deliveries its host made so far: what changes while anything moves. */
    readonly deliveries: number;
    readonly runs: readonly InProcessRunRecord["kind"][];
  };
  /**
   * Ends `sessionId` here deliberately: its turn is cancelled, the sessions its runs opened end
   * with it, its sandbox is released, and its stream records the end, on the World too. Resolves
   * once it ended; at once for a session that isn't running here.
   */
  end(sessionId: string): Promise<void>;
  /**
   * Stops serving, for this runtime and every runtime its host made, and waits for each session's
   * loop to stop. On a World the runtime was given, its sessions are suspended, not ended: the
   * World keeps each as it was, and nothing it holds (its sandbox, its files, the runs and
   * sessions it started) is torn down, so `restore` continues it as after a crash. Without one,
   * they end; so they do with `suspend: false`. To end one session on purpose, use `end`.
   */
  dispose(options?: { readonly suspend?: boolean }): Promise<void>;
}

/**
 * A runtime that runs each session in this process, through the session loop a deployment runs.
 * Its streams are the same as Workflow's, so clients and protocol checks work unchanged.
 */
export function createInProcessRuntime(
  config: SessionRuntimeConfig,
  options: InProcessRuntimeOptions = {},
): InProcessRuntime {
  const runtimes = new Map<string, InProcessRuntime>();
  const runtimeFor = (child: SessionRuntimeConfig): InProcessRuntime => {
    const key = JSON.stringify(child);
    let runtime = runtimes.get(key);
    if (runtime === undefined) runtimes.set(key, (runtime = runtimeOn(host, child)));
    return runtime;
  };
  const host = createInProcessHost(options, runtimeFor);
  return runtimeFor(config);
}

/** The runtime for sessions of `config`'s agent on `host`. */
function runtimeOn(host: InProcessHost, config: SessionRuntimeConfig): InProcessRuntime {
  const { inboxes, lines, records, running, sessions, store, timers } = host;

  /** The idle timeout of `sessionId`, which tells the session's inbox when it expires. */
  const timeoutsFor =
    (sessionId: string): SessionTimeouts =>
    (timeout) =>
      createInProcessTimeoutControl({
        ...timeout,
        signal: () => {
          void inboxes.deliver(sessionCommandHookToken(sessionId), {
            kind: "session-timeout",
            ownerRunId: sessionId,
          });
        },
        timers,
      });

  /** What `sessionId`'s addresses keep, through its record once it has one. */
  const keeperOf =
    (sessionId: string): Keep<Arrival> =>
    async (token, arrival) =>
      await records.get(sessionId)?.keep(token, arrival);

  /**
   * Opens `sessionId`'s stream: lines are kept on the World in batches, each before a reader sees
   * it, and a call's start is kept before the tool runs (`isBarrierLine`).
   */
  const openStream = (sessionId: string, recorded: readonly string[] = [], from = 0) => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const writable = lines.open(
      sessionId,
      recorded.map((line) => encoder.encode(line)),
      async (position, batch) =>
        await store.appendLines(
          sessionId,
          position,
          batch.map((line) => decoder.decode(line)),
        ),
      isBarrierLine,
      from,
    );
    if (host.servesLines) host.onDispose(registerSessionLineStore(sessionId, lines));
    return writable;
  };

  /** The record of the session `boot` starts, which keeps its addresses' inputs from now on. */
  const hostedSession = (
    boot: SessionBoot,
    saved?: {
      readonly inputs?: SessionSnapshot["inputs"];
      readonly lostRuns: readonly RunSnapshot[];
    },
  ): HostedSession => {
    const decoder = new TextDecoder();
    const record = new HostedSession({
      boot,
      lines: () => lines.recorded(boot.sessionId).map((line) => decoder.decode(line)),
      linesFrom: () => lines.heldFrom(boot.sessionId),
      flushLines: () => lines.flush(boot.sessionId),
      runs: (heard) => host.runs.unheard(boot.sessionId, heard),
      suspended: host.suspended,
      ...(saved?.inputs !== undefined && { inputs: saved.inputs }),
      ...(saved !== undefined && { lostRuns: saved.lostRuns }),
      store,
    });
    records.set(boot.sessionId, record);
    return record;
  };

  /**
   * `inbox`, counting its session as parked while its loop waits on it: for its next message,
   * an answer, a run's report, or a timer, which all arrive there.
   */
  const parkedWhileReading = (inbox: SessionInboxHandle, id: string): SessionInboxHandle => {
    const { parked } = host;
    host.readers.set(id, inbox);
    const waiting = async <T>(read: Promise<T>): Promise<T> => {
      parked.set(id, (parked.get(id) ?? 0) + 1);
      try {
        return await read;
      } finally {
        const left = (parked.get(id) ?? 1) - 1;
        if (left === 0) parked.delete(id);
        else parked.set(id, left);
      }
    };
    return new Proxy(inbox, {
      get(target, property) {
        if (property === "next") return () => waiting(target.next());
        if (property === "whenPending") return () => waiting(target.whenPending());
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };

  // Sessions that ended here, rather than stopped by a suspension.
  const endedHere = new Set<string>();

  const run = (record: HostedSession, boot: SessionBoot, inbox: SessionInboxHandle): void => {
    const { sessionId } = boot;
    const loop = startPreparedSession(
      boot,
      parkedWhileReading(inbox, sessionId),
      host.sessionHost(record),
    );
    sessions.set(sessionId, { loop, record });
    const session = loop.finished.then(
      () => {
        if (!host.suspended()) endedHere.add(sessionId);
      },
      (error: unknown) => {
        // Another process continued the session: nothing of this one's reached the World after.
        if (isTakenOver(error))
          log.warn("session continued in another process; this one stopped writing it", {
            sessionId,
          });
        // Otherwise the session's stream records how it ended.
      },
    );
    running.set(sessionId, session);
    void session.finally(() => {
      running.delete(sessionId);
      sessions.delete(sessionId);
      host.readers.delete(sessionId);
      if (records.get(sessionId) === record) records.delete(sessionId);
    });
  };

  /**
   * Boots and runs a session from its initial entry, as Workflow's `workflowEntry` does. When
   * another session holds the continuation token, the message went to it, and that's the one.
   */
  const startEntry = (
    entry: Omit<InitialWorkflowEntryInput, "ownerDeploymentId">,
    continuationToken: string | undefined,
    sessionId = `session_${createUlid()}`,
  ): Promise<{ readonly sessionId: string; readonly claimedContinuation: boolean }> =>
    host.working(() => bootEntry(entry, continuationToken, sessionId));
  const bootEntry = async (
    entry: Omit<InitialWorkflowEntryInput, "ownerDeploymentId">,
    continuationToken: string | undefined,
    sessionId: string,
  ): Promise<{ readonly sessionId: string; readonly claimedContinuation: boolean }> => {
    const sessionWritable = openStream(sessionId);
    const boot = await bootInitialOwner(
      { ...entry, ownerDeploymentId: host.deploymentId },
      sessionId,
      {
        inboxTransport: inboxes.transportFor(sessionId, { keep: keeperOf(sessionId) }),
        sessionWritable,
        timeouts: timeoutsFor(sessionId),
        async settleContinuationConflict({ command, continuationToken: token }) {
          if (inboxes.holder(token) === undefined)
            throw new Error(`No session here holds continuation "${token}".`);
          await host.deliverCommand(token, command);
        },
      },
    );
    if (boot === undefined) {
      const holder = inboxes.holder(continuationToken ?? "");
      if (holder === undefined) throw new Error("The session's address is held elsewhere.");
      return { claimedContinuation: false, sessionId: holder };
    }
    // Saved before the session accepts its first message: as the step it starts with.
    const record = hostedSession(boot.session);
    await record.save();
    run(record, boot.session, boot.inbox);
    return { claimedContinuation: true, sessionId };
  };

  const restore = async (
    snapshot: SessionSnapshot,
    options: { readonly stored?: boolean } = {},
  ): Promise<{ readonly sessionId: string }> => {
    const { sessionId } = snapshot;
    const plan = planRestore(snapshot, { hasStore: host.keeps });
    if (sessions.has(sessionId)) throw new Error(`Session "${sessionId}" already runs here.`);
    if (options.stored !== true) await saveSnapshot(store, snapshot);
    const sessionWritable = openStream(sessionId, snapshot.lines, snapshot.linesFrom);
    const { checkpoint } = plan;
    const timeout = timeoutsFor(sessionId)({
      sessionId,
      timeoutMs: checkpoint.sessionTimeoutMs,
      ...(plan.deadline !== undefined && { deadline: plan.deadline }),
    });
    const boot = bootFromCheckpoint(checkpoint, {
      ...plan.boot,
      anchor: { kind: "self" },
      deploymentId: host.deploymentId,
      sessionId,
      sessionWritable,
      ...(timeout !== undefined && { sessionTimeoutControl: timeout }),
    });
    const record = hostedSession(boot, { inputs: snapshot.inputs, lostRuns: plan.lostRuns });
    const inbox = createSessionInbox(
      inboxes.transportFor(sessionId, { keep: keeperOf(sessionId) }),
    );
    await inbox.claimSessionHooks(
      sessionHookTokens({
        serializedContext: plan.boot.serializedContext,
        sessionState: checkpoint.sessionState,
      }),
    );
    // Queued before the loop starts, so the turn reads them first, in the order they arrived;
    // then each lost run's report, which the session keeps as it does any run's. The runs that
    // go on start before the session is saved, which keeps them as its own.
    for (const input of plan.redeliver)
      inboxes.requeue(input.token, "command" in input ? input.command : input.runMessage);
    for (const lost of plan.lostRuns) {
      const { inbox: ownerInbox, outcome } = interruptedRunOutcome(lost);
      // The session holds its inbox here now; a run's owner elsewhere is reached by route.
      const local = await inboxes.deliver(
        logicalSessionInboxToken(ownerInbox) ?? ownerInbox,
        outcome,
      );
      if (local?.kind !== "delivered") await resumeRoutedHook(ownerInbox, outcome);
    }
    for (const { heard, run: resumed } of plan.resumedRuns) host.runs.resume(resumed, heard);
    await record.save();
    run(record, boot, inbox);
    return { sessionId };
  };

  /** Starts a session from `input`, under `sessionId` when given (one its World holds already). */
  const startSession = async (input: RunInput, sessionId?: string): Promise<RunHandle> => {
    const prepared = await prepareInitialEntry(config, input);
    const started = await startEntry(prepared.entry, input.continuationToken, sessionId);
    const delivery = prepared.input.delivery;
    if (!started.claimedContinuation) {
      // As Workflow's handle for a start that lost the address: it created nothing.
      return {
        claimedContinuation: false,
        events: readSessionEventStream(started.sessionId),
        sessionId: started.sessionId,
        ...(delivery !== undefined && { deliveryId: delivery.deliveryId }),
      };
    }
    let events: ReadableStream | undefined;
    return {
      get events() {
        return (events ??= readSessionEventStream(started.sessionId));
      },
      sessionId: started.sessionId,
      ...(delivery !== undefined && { deliveryId: delivery.deliveryId }),
    };
  };

  return {
    createSession: (input) => startSession(input),

    startSession: (sessionId, input) => startSession(input, sessionId),

    quiescent: () => host.quiescent(),

    busy: () => host.busy(),

    nextTimer: () => timers.next(),

    drain: () => host.drain(),

    ended: (sessionId) => endedHere.has(sessionId),

    async deliver(token, payload) {
      return (await inboxes.deliver(logicalSessionInboxToken(token) ?? token, payload))?.kind;
    },

    startEntry: (entry, sessionId) => startEntry(entry, undefined, sessionId),

    async dispatchContinuation<TCommand extends SessionCommand>(
      input: DispatchContinuationInput<TCommand>,
    ): Promise<SessionCommandResult<TCommand>> {
      return await host.deliverCommand(input.continuationToken, input.command);
    },

    async dispatchSession<TCommand extends SessionCommand>(
      input: DispatchSessionInput<TCommand>,
    ): Promise<SessionCommandResult<TCommand>> {
      return await host.deliverCommand(sessionCommandHookToken(input.sessionId), input.command);
    },

    async resolveContinuation(continuationToken) {
      const sessionId = inboxes.holder(continuationToken);
      return sessionId === undefined ? undefined : { sessionId };
    },

    async getEventStream(sessionId, options) {
      return options?.follow === false
        ? readSessionEventHistory(sessionId, options.startIndex, options.signal)
        : readSessionEventStream(sessionId, options?.startIndex, options?.signal);
    },

    async getLineStream(sessionId, options) {
      return options?.follow === false
        ? readSessionRecordHistory(sessionId, options.startIndex)
        : readSessionRecords(sessionId, options?.startIndex);
    },

    async getStreamTailIndex(sessionId) {
      return await readSessionStreamTailIndex(sessionId);
    },

    async settled(sessionId) {
      await running.get(sessionId);
    },

    holds: (token) => inboxes.holder(token) !== undefined,

    stepsRunning: (sessionId) => host.stepsRunning(sessionId),

    async idle(sessionId) {
      if (sessionId === undefined) return await host.idle();
      await sessions.get(sessionId)?.loop.settledStep();
    },

    async snapshot(sessionId) {
      const live = sessions.get(sessionId);
      if (live === undefined) throw new Error(`Session "${sessionId}" isn't running here.`);
      await live.loop.settledStep();
      return live.record.snapshot();
    },

    restore(snapshot, restoreOptions) {
      // One restore of a session at a time: a run reopening a child, and a host's restart
      // restoring every session it ran, can reach the same one.
      const { sessionId } = snapshot;
      let restoring = host.restoring.get(sessionId);
      if (restoring === undefined) {
        restoring = host.working(() => restore(snapshot, restoreOptions));
        host.restoring.set(sessionId, restoring);
        void restoring.then(
          () => host.restoring.delete(sessionId),
          () => host.restoring.delete(sessionId),
        );
      }
      return restoring;
    },

    load: (sessionId, loadOptions) => store.load(sessionId, loadOptions),

    sessions: () => store.list(),

    async end(sessionId) {
      if (!running.has(sessionId)) return;
      // A reset ends a session, as it ends the session a parent's run opened.
      await host.deliverCommand(sessionCommandHookToken(sessionId), {
        deliveryId: `end-${createUlid()}`,
        kind: "reset",
      });
      // Its end stops its runs, and each run ends the sessions it opened, after it: the session
      // has ended once all of them have.
      const ended = async (id: string): Promise<void> => {
        await running.get(id);
        await Promise.all((await host.runs.finished(id)).map(ended));
      };
      await ended(sessionId);
    },

    activity: () => ({
      // Parked with nothing unread: input it has yet to take isn't rest.
      parked: [...host.parked.keys()].filter(
        (id) => sessions.has(id) && host.readers.get(id)?.hasPending() !== true,
      ),
      working: host.busy(),
      deliveries: host.deliveries(),
      runs: host.runs.live().map((run) => run.kind),
      sessions: [...sessions.keys()],
    }),

    registerWorkflow: (workflowId, workflowBody) =>
      host.runs.registerWorkflow(workflowId, workflowBody),

    dispose: (options) => host.dispose(options),
  };
}
