import type {
  DispatchContinuationInput,
  DispatchSessionInput,
  RunHandle,
  RunInput,
  Runtime,
  SessionCommand,
  SessionCommandResult,
} from "#channel/types.js";
import { dispatchCoordinationOn } from "#execution/coordination-dispatch-step.js";
import { registerSessionLineStore } from "#execution/hosts.js";
import { prepareInitialEntry, type SessionRuntimeConfig } from "#execution/initial-entry.js";
import {
  activeCommandResult,
  identifyCommand,
  inactiveCommandResult,
} from "#execution/session-commands.js";
import {
  readSessionEventHistory,
  readSessionEventStream,
  readSessionRecordHistory,
  readSessionRecords,
  readSessionStreamTailIndex,
} from "#execution/session-event-stream.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { bootInitialOwner } from "#execution/session/owner-boot.js";
import {
  runPreparedSession,
  type SessionHost,
  type SessionMoves,
} from "#execution/session/program.js";
import { turnStepOn, type SessionStepHost } from "#execution/session/turn-step.js";
import { applyRunMessagesOn } from "#execution/tools/workflow/apply-run-messages.js";
import { createUlid } from "#shared/ulid.js";
import { createMemoryInboxRegistry } from "./inbox-transport.js";
import { createMemoryLineStore } from "./line-store.js";
import { acrossStepBoundary, structuredCloneBoundary, type StepBoundary } from "./step-boundary.js";

// A Runtime whose sessions run in this process: the same session loop, turn steps, and kernel a
// deployment runs, with their streams, addresses, and steps held in memory. Nothing survives the
// process, a session never moves between owners, and no timer ends one. What needs a durable run
// of its own (a task, a workflow tool, or a subagent) is refused, saying what it needs.

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

const IN_PROCESS_STEP_HOST: SessionStepHost = {
  createRuntime: () => NO_DURABLE_RUNS,
  // Attributes belong to a Workflow run; an in-process session has none.
  setAttributes: async () => {},
};

const runTurnStep = turnStepOn(IN_PROCESS_STEP_HOST);

/**
 * The host a session's loop runs on. Each turn step's data crosses `boundary` each way, as it
 * would cross a deployment's serializer; its stream and signals are services, which cross as
 * they are.
 */
function inProcessSessionHost(boundary: StepBoundary): SessionHost {
  return {
    // Without runs, no run sends anything.
    applyRunMessages: applyRunMessagesOn({
      recordRemoteBinding: async () => unavailable("A remote agent"),
      stopLate: async () => unavailable("A subagent"),
    }),
    // Each call that needs a run of its own fails with why, as a run that can't start does.
    dispatchRuns: dispatchCoordinationOn(async ({ toolName }) =>
      unavailable(`The \`${toolName}\` tool`),
    ),
    moves: IN_PROCESS_MOVES,
    async runTurnStep(input) {
      const { abortSignal, sessionWritable, steeringSignal, ...data } = input;
      const crossed = await acrossStepBoundary(boundary, data);
      return await acrossStepBoundary(
        boundary,
        await runTurnStep({ ...crossed, abortSignal, sessionWritable, steeringSignal }),
      );
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export interface InProcessRuntimeOptions {
  /**
   * How a step's data crosses between the loop and the step. A structured clone by default; a
   * test that needs a deployment's exact serializer passes Workflow's
   * (`workflow-host/step-boundary.ts`), which this module never loads itself.
   */
  readonly stepBoundary?: StepBoundary;
}

export interface InProcessRuntime extends Runtime {
  /** Resolves once `sessionId`'s session ends here, or at once for one that isn't running. */
  settled(sessionId: string): Promise<void>;
  /**
   * Stops serving: closes every session's addresses, waits for each session to end, and stops
   * reading their streams.
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
  const host = inProcessSessionHost(options.stepBoundary ?? structuredCloneBoundary);
  const lines = createMemoryLineStore();
  const inboxes = createMemoryInboxRegistry();
  const unregister: (() => void)[] = [];
  const running = new Map<string, Promise<void>>();

  const dispatch = <TCommand extends SessionCommand>(
    token: string,
    command: TCommand,
  ): SessionCommandResult<TCommand> => {
    const identified = identifyCommand(command);
    const held = inboxes.deliver(token, identified);
    return held === undefined
      ? inactiveCommandResult(identified)
      : activeCommandResult(identified, held.sessionId);
  };

  return {
    async createSession(input: RunInput): Promise<RunHandle> {
      const prepared = await prepareInitialEntry(config, input);
      const sessionId = `session_${createUlid()}`;
      const sessionWritable = lines.open(sessionId);
      unregister.push(registerSessionLineStore(sessionId, lines));
      const boot = await bootInitialOwner(
        { ...prepared.entry, ownerDeploymentId: IN_PROCESS_DEPLOYMENT_ID },
        sessionId,
        {
          inboxTransport: inboxes.transportFor(sessionId),
          sessionWritable,
          // No timer ends a session here.
          timeouts: () => undefined,
          async settleContinuationConflict({ command, continuationToken }) {
            if (inboxes.holder(continuationToken) === undefined)
              throw new Error(`No session here holds continuation "${continuationToken}".`);
            dispatch(continuationToken, command);
          },
        },
      );
      if (boot === undefined) {
        // Another session holds the continuation token, and the message went to it.
        const holder = inboxes.holder(input.continuationToken ?? "");
        if (holder === undefined) throw new Error("The session's address is held elsewhere.");
        return { events: readSessionEventStream(holder), sessionId: holder };
      }
      const session = runPreparedSession(boot.session, boot.inbox, host).then(
        () => undefined,
        // The session's stream records how it ended.
        () => undefined,
      );
      running.set(sessionId, session);
      void session.finally(() => running.delete(sessionId));
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
      return dispatch(input.continuationToken, input.command);
    },

    async dispatchSession<TCommand extends SessionCommand>(
      input: DispatchSessionInput<TCommand>,
    ): Promise<SessionCommandResult<TCommand>> {
      return dispatch(sessionCommandHookToken(input.sessionId), input.command);
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

    async dispose() {
      inboxes.closeAll();
      await Promise.all(running.values());
      for (const release of unregister.splice(0)) release();
    },
  };
}
