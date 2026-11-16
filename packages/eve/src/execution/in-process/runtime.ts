import type {
  DispatchContinuationInput,
  DispatchSessionInput,
  RunHandle,
  RunInput,
  Runtime,
  SessionCommand,
  SessionCommandResult,
} from "#channel/types.js";
import { registerSessionLineStore } from "#execution/hosts.js";
import { prepareInitialEntry, type SessionRuntimeConfig } from "#execution/initial-entry.js";
import {
  readSessionEventHistory,
  readSessionEventStream,
  readSessionRecordHistory,
  readSessionRecords,
  readSessionStreamTailIndex,
} from "#execution/session-event-stream.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { bootInitialOwner } from "#execution/session/owner-boot.js";
import type { InitialWorkflowEntryInput } from "#execution/session/entry-input.js";
import { runPreparedSession } from "#execution/session/program.js";
import { createUlid } from "#shared/ulid.js";
import { createInProcessHost, type InProcessHost, type InProcessHostOptions } from "./host.js";
import type { WorkflowFunction } from "./runs.js";

// A Runtime whose sessions run in this process: the same session loop, turn steps, and kernel a
// deployment runs, with their streams, addresses, steps, and timers held in memory (`host.ts`).
// Nothing survives the process, a session never moves between owners, and no timer ends one.
// Workflow tool runs (subagents, the `agent` tool, tasks, workflow tools) run here too
// (`runs.ts`), and the sessions they open run on this runtime's siblings, which share its host.

export type InProcessRuntimeOptions = InProcessHostOptions;

export interface InProcessRuntime extends Runtime {
  /** Resolves once `sessionId`'s session ends here, or at once for one that isn't running. */
  settled(sessionId: string): Promise<void>;
  /** Whether a session here holds the address `token` names. */
  holds(token: string): boolean;
  /** How many of `sessionId`'s turn steps are running now. */
  stepsRunning(sessionId: string): number;
  /**
   * Resolves once nothing on its host is working: no delivery, step or session start is in
   * flight, so each session and run waits on a message, a person or a timer.
   */
  idle(): Promise<void>;
  /**
   * Starts a session from the initial entry Workflow's `workflowEntry` takes, for tests written
   * against it.
   */
  startEntry(
    entry: Omit<InitialWorkflowEntryInput, "ownerDeploymentId">,
  ): Promise<{ readonly sessionId: string }>;
  /** Makes an authored workflow tool's body, its `"use workflow"` function's twin, run here. */
  registerWorkflow(workflowId: string, body: WorkflowFunction): void;
  /**
   * Stops serving, for this runtime and every runtime its host made: closes every session's
   * addresses, waits for each session to end, and stops reading their streams.
   */
  dispose(): Promise<void>;
}

/**
 * A runtime for tests that runs each session in this process, through the session loop a
 * deployment runs. Its streams are the same as Workflow's, so clients and protocol checks work
 * unchanged.
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
  const { inboxes, lines, running } = host;

  /**
   * Boots and runs a session from its initial entry, as Workflow's `workflowEntry` does. When
   * another session holds the continuation token, the message went to it, and that's the one.
   */
  const startEntry = (
    entry: Omit<InitialWorkflowEntryInput, "ownerDeploymentId">,
    continuationToken: string | undefined,
  ): Promise<{ readonly sessionId: string; readonly claimedContinuation: boolean }> =>
    host.working(() => bootEntry(entry, continuationToken));
  const bootEntry = async (
    entry: Omit<InitialWorkflowEntryInput, "ownerDeploymentId">,
    continuationToken: string | undefined,
  ): Promise<{ readonly sessionId: string; readonly claimedContinuation: boolean }> => {
    const sessionId = `session_${createUlid()}`;
    const sessionWritable = lines.open(sessionId);
    host.onDispose(registerSessionLineStore(sessionId, lines));
    const boot = await bootInitialOwner(
      { ...entry, ownerDeploymentId: host.deploymentId },
      sessionId,
      {
        inboxTransport: inboxes.transportFor(sessionId),
        sessionWritable,
        // No timer ends a session here.
        timeouts: () => undefined,
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
    const session = runPreparedSession(boot.session, boot.inbox, host.sessionHost).then(
      () => undefined,
      // The session's stream records how it ended.
      () => undefined,
    );
    running.set(sessionId, session);
    void session.finally(() => running.delete(sessionId));
    return { claimedContinuation: true, sessionId };
  };

  return {
    async createSession(input: RunInput): Promise<RunHandle> {
      const prepared = await prepareInitialEntry(config, input);
      const started = await startEntry(prepared.entry, input.continuationToken);
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
    },

    startEntry: (entry) => startEntry(entry, undefined),

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

    idle: () => host.idle(),

    registerWorkflow: (workflowId, workflowBody) =>
      host.runs.registerWorkflow(workflowId, workflowBody),

    dispose: () => host.dispose(),
  };
}
