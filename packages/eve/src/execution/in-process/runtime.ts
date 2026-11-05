import { createLogger } from "#internal/logging.js";
import { isTakenOver } from "#execution/entity/entities.js";
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
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { createSessionInbox, type SessionInboxHandle } from "#execution/session-inbox/inbox.js";
import { bootFromCheckpoint } from "#execution/session/checkpoint-boot.js";
import { bootInitialOwner } from "#execution/session/owner-boot.js";
import { sessionHookTokens } from "#execution/session/hook-tokens.js";
import { startPreparedSession, type SessionBoot } from "#execution/session/program.js";
import type { SessionTimeouts } from "#execution/session/timeout-control.js";
import { createUlid } from "#shared/ulid.js";
import { createInProcessHost, type InProcessHost, type InProcessHostOptions } from "./host.js";
import type { Keep, Arrival } from "./inbox-transport.js";
import { planRestore } from "./restore.js";
import { interruptedRunOutcome, type RunSnapshot, type WorkflowFunction } from "./runs.js";
import { HostedSession } from "./session-record.js";
import { saveSnapshot, type StoredSession } from "./session-store.js";
import type { SessionSnapshot } from "./snapshot.js";
import { createInProcessTimeoutControl } from "./timers.js";

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

// A Runtime whose sessions run in this process: the same session loop, turn steps, and kernel a
// deployment runs, with their addresses, steps, and timers held here (`host.ts`). Each session is
// a run on the runtime's World, which keeps it as it runs (`session-record.ts`, `world-store.ts`),
// so another runtime on that World continues it, a turn a crash cut off going on from its last
// step. A session never moves between owners. Workflow tool runs (subagents, the `agent` tool,
// tasks, workflow tools) run here too (`runs.ts`), and the sessions they open run on this
// runtime's siblings, which share its host.

export type InProcessRuntimeOptions = InProcessHostOptions;

export interface InProcessRuntime extends Runtime {
  /** Resolves once `sessionId`'s session ends here, or at once for one that isn't running. */
  settled(sessionId: string): Promise<void>;
  /**
   * Resolves once no step of `sessionId`'s session runs and the loop recorded the last one, or
   * at once for a session that isn't running here.
   */
  idle(sessionId: string): Promise<void>;
  /**
   * A session as another process can restore it, with the runs it hadn't heard the end of. It
   * waits for a running step to return (a model call, or a long tool call); a session waiting
   * for its next message, on a person, or on its runs restores as it was, its turn going on from
   * there. For a session mid-step, read `store.load(id)`, which holds it at any moment.
   */
  snapshot(sessionId: string): Promise<SessionSnapshot>;
  /**
   * Continues a session from its snapshot, under the snapshot's session id. With the store that
   * kept the sessions its subagents opened, their runs go on; any other run it had reports as
   * interrupted. A snapshot this build can't read is refused, with why.
   */
  restore(snapshot: SessionSnapshot): Promise<{ readonly sessionId: string }>;
  /** The session the runtime's World holds under `sessionId`, as `restore` continues it. */
  load(sessionId: string): Promise<SessionSnapshot | undefined>;
  /** The sessions the runtime's World holds, most recently saved first. */
  sessions(): Promise<readonly StoredSession[]>;
  /** Makes an authored workflow tool's body, its `"use workflow"` function's twin, run here. */
  registerWorkflow(workflowId: string, body: WorkflowFunction): void;
  /**
   * Ends `sessionId` here deliberately: its turn is cancelled, the sessions its runs opened end
   * with it, its sandbox is released, and its stream records the end, in the store too. Resolves
   * once it ended; at once for a session that isn't running here.
   */
  end(sessionId: string): Promise<void>;
  /**
   * Stops serving, for this runtime and every runtime its host made, and waits for each session's
   * loop to stop. With a store, its sessions are suspended, not ended: the store keeps each as it
   * was, and nothing it holds (its sandbox, its files, the runs and sessions it started) is torn
   * down, so `restore` continues it as after a crash. Without one, they end. To end a session on
   * purpose, use `end`.
   */
  dispose(): Promise<void>;
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
    // An agent defined in code is a held record of functions, which its id names.
    const key = child.agent === undefined ? JSON.stringify(child) : `agent:${child.agent.id}`;
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
  const openStream = (sessionId: string, recorded: readonly string[] = []) => {
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
    );
    host.onDispose(registerSessionLineStore(sessionId, lines));
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

  const run = (record: HostedSession, boot: SessionBoot, inbox: SessionInboxHandle): void => {
    const { sessionId } = boot;
    const loop = startPreparedSession(boot, inbox, host.sessionHost(record));
    sessions.set(sessionId, { loop, record });
    const session = loop.finished.then(
      () => undefined,
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
      if (records.get(sessionId) === record) records.delete(sessionId);
    });
  };

  return {
    async createSession(input: RunInput): Promise<RunHandle> {
      const prepared = await prepareInitialEntry(config, input);
      const sessionId = `session_${createUlid()}`;
      const sessionWritable = openStream(sessionId);
      const boot = await bootInitialOwner(
        { ...prepared.entry, ownerDeploymentId: host.deploymentId },
        sessionId,
        {
          inboxTransport: inboxes.transportFor(sessionId, { keep: keeperOf(sessionId) }),
          sessionWritable,
          async settleContinuationConflict({ command, continuationToken }) {
            if (inboxes.holder(continuationToken) === undefined)
              throw new Error(`No session here holds continuation "${continuationToken}".`);
            await host.deliverCommand(continuationToken, command);
          },
          timeouts: timeoutsFor(sessionId),
        },
      );
      if (boot === undefined) {
        // Another session holds the continuation token, and the message went to it.
        const holder = inboxes.holder(input.continuationToken ?? "");
        if (holder === undefined) throw new Error("The session's address is held elsewhere.");
        return { events: readSessionEventStream(holder), sessionId: holder };
      }
      // Saved before the session accepts its first message: as the step it starts with.
      const record = hostedSession(boot.session);
      await record.save();
      run(record, boot.session, boot.inbox);
      let events: ReadableStream | undefined;
      return {
        get events() {
          return (events ??= readSessionEventStream(sessionId));
        },
        sessionId,
        ...(prepared.input.delivery !== undefined && {
          deliveryId: prepared.input.delivery.deliveryId,
        }),
      };
    },

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

    async idle(sessionId) {
      await sessions.get(sessionId)?.loop.settledStep();
    },

    async snapshot(sessionId) {
      const live = sessions.get(sessionId);
      if (live === undefined) throw new Error(`Session "${sessionId}" isn't running here.`);
      await live.loop.settledStep();
      return live.record.snapshot();
    },

    async restore(snapshot) {
      const { sessionId } = snapshot;
      const plan = planRestore(snapshot, { hasStore: host.keeps });
      if (sessions.has(sessionId)) throw new Error(`Session "${sessionId}" already runs here.`);
      await saveSnapshot(store, snapshot);
      const sessionWritable = openStream(sessionId, snapshot.lines);
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
        await resumeRoutedHook(ownerInbox, outcome);
      }
      for (const { heard, run: resumed } of plan.resumedRuns) host.runs.resume(resumed, heard);
      await record.save();
      run(record, boot, inbox);
      return { sessionId };
    },

    load: (sessionId) => store.load(sessionId),

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

    registerWorkflow(workflowId, body) {
      host.runs.registerWorkflow(workflowId, body);
    },

    dispose: () => host.dispose(),
  };
}
