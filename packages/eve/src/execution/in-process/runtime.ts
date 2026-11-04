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
import type { DeliverHookPayload } from "#channel/types.js";
import {
  registerHost,
  registerSessionLineStore,
  resumeRoutedHook,
  resumeRoutedSessionInbox,
  type DurableHost,
} from "#execution/hosts.js";
import type { SessionInboxPayload } from "#execution/session-inbox/inbox.js";
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
import {
  logicalSessionInboxToken,
  sessionCommandHookToken,
} from "#execution/session-inbox/address.js";
import { bootInitialOwner } from "#execution/session/owner-boot.js";
import { runPreparedSession, type SessionHost } from "#execution/session/program.js";
import { turnStepOn, type SessionStepHost } from "#execution/session/turn-step.js";
import { applyRunMessagesOn } from "#execution/tools/workflow/apply-run-messages.js";
import { isHookNotFound } from "#shared/run-errors.js";
import { createUlid } from "#shared/ulid.js";
import { createMemoryInboxRegistry, type MemoryInboxRegistry } from "./inbox-transport.js";
import { createMemoryLineStore } from "./line-store.js";
import { acrossStepBoundary, structuredCloneBoundary, type StepBoundary } from "./step-boundary.js";

// A Runtime whose sessions run in this process: the same session loop, turn steps, and kernel a
// deployment runs, with their streams, addresses, and steps held in memory. Nothing survives the
// process, a session never moves between owners, and no timer ends one. What needs a durable run
// of its own (a task, a workflow tool, or a subagent) is refused, saying what it needs.

const IN_PROCESS_DEPLOYMENT_ID = "in-process";

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

/** What a turn step here reaches: sign-in callbacks at `callbackBaseUrl`, when it's given. */
function inProcessStepHost(callbackBaseUrl: string | undefined): SessionStepHost {
  return {
    createRuntime: () => NO_DURABLE_RUNS,
    // Attributes belong to a Workflow run; an in-process session has none.
    setAttributes: async () => {},
    ...(callbackBaseUrl !== undefined && { callbackBaseUrl, deliver: deliverRouted }),
  };
}

/**
 * The host a session's loop runs on. Each turn step's data crosses `boundary` each way, as it
 * would cross a deployment's serializer; its stream and signals are services, which cross as
 * they are. `steps` counts each session's turn steps in flight.
 */
function inProcessSessionHost(
  boundary: StepBoundary,
  stepHost: SessionStepHost,
  steps: Map<string, number>,
): SessionHost {
  const runTurnStep = turnStepOn(stepHost);
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
    async runTurnStep(input) {
      const { abortSignal, sessionWritable, steeringSignal, ...data } = input;
      const { sessionId } = input.sessionState;
      steps.set(sessionId, (steps.get(sessionId) ?? 0) + 1);
      try {
        const crossed = await acrossStepBoundary(boundary, data);
        return await acrossStepBoundary(
          boundary,
          await runTurnStep({ ...crossed, abortSignal, sessionWritable, steeringSignal }),
        );
      } finally {
        const left = (steps.get(sessionId) ?? 1) - 1;
        if (left === 0) steps.delete(sessionId);
        else steps.set(sessionId, left);
      }
    },
    until: (at) => new Promise((resolve) => setTimeout(resolve, Math.max(0, at - Date.now()))),
  };
}

export interface InProcessRuntimeOptions {
  /**
   * How a step's data crosses between the loop and the step. A structured clone by default; a
   * test that needs a deployment's exact serializer passes Workflow's
   * (`workflow-host/step-boundary.ts`), which this module never loads itself.
   */
  readonly stepBoundary?: StepBoundary;
  /**
   * The base URL sign-in callbacks reach its sessions at. Without it, a session can't call a
   * sign-in back, as a Workflow session outside a run can't.
   */
  readonly callbackBaseUrl?: string;
}

export interface InProcessRuntime extends Runtime {
  /** Resolves once `sessionId`'s session ends here, or at once for one that isn't running. */
  settled(sessionId: string): Promise<void>;
  /** Whether a session here holds the address `token` names. */
  holds(token: string): boolean;
  /** How many of `sessionId`'s turn steps are running now. */
  stepsRunning(sessionId: string): number;
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
  const steps = new Map<string, number>();
  const host = inProcessSessionHost(
    options.stepBoundary ?? structuredCloneBoundary,
    inProcessStepHost(options.callbackBaseUrl),
    steps,
  );
  const lines = createMemoryLineStore();
  const inboxes = createMemoryInboxRegistry();
  // Hooks this runtime's sessions hold, for what reaches them by token (a sign-in callback). It
  // runs no runs.
  const unregister: (() => void)[] = [
    registerHost({
      cancelRun: () => undefined,
      // A session inbox's token comes as its physical hook token (`eve:inbox:...`), as a sign-in
      // callback's URL carries it; its inbox here holds the logical token.
      deliver: async (token, payload) =>
        inboxes.deliver(
          logicalSessionInboxToken(token) ?? token,
          payload as SessionInboxPayload,
        ) === undefined
          ? undefined
          : "delivered",
      runEnded: () => undefined,
    }),
  ];
  const running = new Map<string, Promise<void>>();

  const dispatch = async <TCommand extends SessionCommand>(
    token: string,
    command: TCommand,
  ): Promise<SessionCommandResult<TCommand>> => {
    const identified = identifyCommand(command);
    const held = inboxes.deliver(token, identified);
    if (held === undefined) return inactiveCommandResult(identified);
    // A reset answers once the session let go of its addresses, as Workflow's does, so a message
    // sent after it starts the next session instead of reaching the one that's ending.
    if (identified.kind === "reset") await addressesReleased(inboxes, held.sessionId);
    return activeCommandResult(identified, held.sessionId);
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
            await dispatch(continuationToken, command);
          },
        },
      );
      if (boot === undefined) {
        // Another session holds the continuation token, and the message went to it.
        const holder = inboxes.holder(input.continuationToken ?? "");
        if (holder === undefined) throw new Error("The session's address is held elsewhere.");
        // As Workflow's handle for a start that lost the address: it created nothing.
        return {
          claimedContinuation: false,
          events: readSessionEventStream(holder),
          sessionId: holder,
          ...(prepared.input.delivery !== undefined && {
            deliveryId: prepared.input.delivery.deliveryId,
          }),
        };
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
      return await dispatch(input.continuationToken, input.command);
    },

    async dispatchSession<TCommand extends SessionCommand>(
      input: DispatchSessionInput<TCommand>,
    ): Promise<SessionCommandResult<TCommand>> {
      return await dispatch(sessionCommandHookToken(input.sessionId), input.command);
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

    stepsRunning: (sessionId) => steps.get(sessionId) ?? 0,

    async dispose() {
      inboxes.closeAll();
      await Promise.all(running.values());
      for (const release of unregister.splice(0)) release();
    },
  };
}

/** How long a reset waits for its session's addresses, as Workflow's ingress does. */
const RESET_RELEASE_TIMEOUT_MS = 30_000;

/**
 * Resolves once `sessionId` holds no address, as Workflow's reset waits for the session's hooks
 * (`waitForSessionHooksRelease`): before the session finishes ending, so a successor can start
 * while the old one still writes its end. One that never lets go fails instead of hanging.
 */
async function addressesReleased(inboxes: MemoryInboxRegistry, sessionId: string): Promise<void> {
  const deadline = Date.now() + RESET_RELEASE_TIMEOUT_MS;
  while (inboxes.holdsAny(sessionId)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for session "${sessionId}" to release its addresses.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
