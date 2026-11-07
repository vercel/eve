import type { Runtime } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import {
  agentSessionsOver,
  type LocalAgentSessions,
} from "#execution/agent-sessions/sessions-over.js";
import { FRAMEWORK_WORKFLOW_BODIES } from "#execution/framework-workflow-bodies.js";
import type { SessionRuntimeConfig } from "#execution/initial-entry.js";
import type { RunHost } from "#execution/run-host.js";
import type {
  WorkflowToolRunOutcomeMessage,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import { resumeHookWherever } from "#execution/tools/workflow/resume-hook.js";
import { runWorkflowToolRun } from "#execution/tools/workflow/run.js";
import {
  workflowToolRunHookToken,
  type StartWorkflowToolRun,
} from "#execution/tools/workflow/start.js";
import type { WorkflowToolRunInput } from "#execution/tools/workflow/types.js";
import { createLogger, logError } from "#internal/logging.js";
import { agentToolServeWorkflowReference } from "#runtime/subagents/workflow-reference.js";
import { createUlid } from "#shared/ulid.js";
import type { Keep, MemoryInboxRegistry } from "./inbox-transport.js";
import { RunReplay, type EarlierRun, type ReceivedPayload } from "./run-replay.js";
import { acrossStepBoundary, type StepBoundary } from "./step-boundary.js";
import type { InProcessTimers } from "./timers.js";

// Workflow tool runs in this process: subagents, the `agent` tool, tasks, and workflow tools.
// Each run is the same owner loop and body Workflow runs (`runWorkflowToolRun`), as a task here.
// Its hooks are addresses in the host's memory inbox, which it reserves as it starts and keeps
// what arrives at in its journal; its sleeps are the host's timers; and the sessions its
// `ctx.agent` opens are sessions of the host's runtimes. What it sends its session, and what the
// session sends it, travel by hook token, as on Workflow.

const log = createLogger("execution.in-process.runs");

/** What the runs need from the host they run on. */
export interface InProcessRunsHost {
  readonly inboxes: MemoryInboxRegistry;
  /** What a started run's input crosses, as a durable run's does its host's serializer. */
  readonly stepBoundary: StepBoundary;
  readonly timers: InProcessTimers;
  /** The runtime that runs sessions of one agent, or one node of a compiled agent, here. */
  runtimeFor(config: SessionRuntimeConfig): Runtime;
  /** Sends a command to a session this host runs. */
  readonly dispatchSession: Runtime["dispatchSession"];
  /**
   * Continues `sessionId` on the runtime for `config`, from the store an earlier process kept it
   * in, unless it runs here already. `false` when the store holds no such session, or, unless
   * `idle`, when it was between turns, so the reply its caller waits for is lost.
   */
  reopenSession(
    config: SessionRuntimeConfig,
    sessionId: string,
    options: { readonly idle: boolean },
  ): Promise<boolean>;
}

/**
 * A run as a session's record keeps it; everything else follows from its input
 * (`runRecordOf`). A run doesn't survive the process: a restore with the store that kept the
 * sessions it opened runs a subagent's again (`InProcessRuns.resume`), and any other run reports
 * to the restored session once, as interrupted: it "may have partly run".
 */
export interface RunSnapshot {
  readonly runId: string;
  /** What its body started from, after the step boundary. */
  readonly input: WorkflowToolRunInput;
  /** The sessions its body opened, in order. */
  readonly children: readonly string[];
  /**
   * What its hooks received, in order: its session's later calls and the replies of the
   * sessions it opened. A run that goes on after a restore reads them again (`run-replay.ts`).
   */
  readonly received: readonly ReceivedPayload[];
}

/** One run, as its input and id determine it. */
export interface InProcessRunRecord {
  readonly runId: string;
  readonly hookToken: string;
  /** The session the run reports to, at its inbox, and the call it runs. */
  readonly sessionId: string;
  readonly ownerInbox: string;
  readonly callId: string;
  readonly taskId?: string;
  /** What it is to the session that started it. */
  readonly kind: "subagent" | "task" | "workflow-tool";
  /** The run as its messages name it, which its outcome is sent as. */
  readonly ref: WorkflowToolRunRef;
}

/** What the model reads of a run that a restore left behind. */
export const INTERRUPTED_RUN_MESSAGE =
  "The session stopped while this ran, and it was restored without it, so it may have partly run. Check what it changed before you start it again.";

/** Why a subagent's run that went on after a restore fails: its agent's reply didn't survive. */
export const LOST_REPLY_MESSAGE =
  "The session stopped while this agent worked, and its reply was lost, so it may have partly run. Check what it changed before you start it again.";

/** The outcome a restored session hears from a run that didn't survive, at its inbox. */
export function interruptedRunOutcome(run: RunSnapshot): {
  readonly inbox: string;
  readonly outcome: { readonly kind: "outcome" } & WorkflowToolRunOutcomeMessage;
} {
  const { ownerInbox, ref } = runRecordOf(run);
  return {
    inbox: ownerInbox,
    outcome: {
      from: ref,
      kind: "outcome",
      result: {
        error: { message: INTERRUPTED_RUN_MESSAGE, name: "RunInterruptedError" },
        status: "failed",
      },
    },
  };
}

export interface InProcessRuns {
  readonly startRun: StartWorkflowToolRun;
  /** Whether `runId` ended, or `undefined` when it never ran here. */
  runEnded(runId: string): boolean | undefined;
  /** Stops `runId`: `true` when it was running, `undefined` when it never ran here. */
  cancelRun(runId: string, reason: string): boolean | undefined;
  /**
   * The runs `sessionId` started that it hasn't heard the end of, for its record: those still
   * running, and those that ended where `heard` says the session hasn't read their outcome.
   */
  unheard(sessionId: string, heard: (run: RunSnapshot) => boolean): readonly RunSnapshot[];
  /**
   * Resolves once every run `sessionId` started ended, with the sessions those runs opened: what
   * ending the session ends with it.
   */
  finished(sessionId: string): Promise<readonly string[]>;
  /** Makes a workflow tool's body available to runs here, under its `workflowId`. */
  registerWorkflow(workflowId: string, body: WorkflowFunction): void;
  /**
   * Runs once more, under its id, a subagent's run an earlier process left. Its session heard
   * `heard` messages from it already, which it doesn't send again.
   */
  resume(run: RunSnapshot, heard: number): void;
}

/** A workflow tool's body, its `"use workflow"` function's plain twin: a function or a generator. */
export type WorkflowFunction = (...args: never[]) => unknown;

/** eve's own workflow bodies, by workflow id. */
const FRAMEWORK_BODIES = new Map(
  FRAMEWORK_WORKFLOW_BODIES.map(({ body, workflowId }) => [workflowId, body]),
);

/** A run here: its snapshot as it grows, and whether it ended. */
interface Run {
  readonly snapshot: RunSnapshot & {
    readonly children: string[];
    readonly received: ReceivedPayload[];
  };
  readonly record: InProcessRunRecord;
  ended: boolean;
  /** Resolves once its body returned, however it ended. */
  finished?: Promise<void>;
}

/** The `n`th hook a run's body opens without naming it. */
const runHookPrefix = (runId: string) => `eve:in-process:${runId}:`;

export function createInProcessRuns(host: InProcessRunsHost): InProcessRuns {
  const runs = new Map<string, Run>();
  const bodies = new Map<string, WorkflowFunction>();

  /** The sessions `run`'s body opens: new ones, or, going on after a restore, those it opened. */
  const localSessions = (run: Run, earlier: EarlierRun): LocalAgentSessions => {
    let opens = 0;
    return {
      async start(prepared, { context }) {
        const opened = run.snapshot.children[opens++];
        if (opened !== undefined) {
          // The session holds the opening message already, and answers the hook it named; or
          // it answered, and the run has the reply.
          const replied = earlier.received.length > 0;
          if (!(await host.reopenSession(prepared.runtime, opened, { idle: replied })))
            throw new Error(LOST_REPLY_MESSAGE);
          return { address: prepared.address(opened), deliveryId: prepared.deliveryId };
        }
        // The child inherits none of the calling session's lineage, as on Workflow.
        const started = await contextStorage.run(
          new ContextContainer({ localDevRequest: context.localDevRequest }),
          () => host.runtimeFor(prepared.runtime).createSession(prepared.runInput),
        );
        run.snapshot.children.push(started.sessionId);
        return { address: prepared.address(started.sessionId), deliveryId: prepared.deliveryId };
      },
      command: async (session, command) =>
        await host.dispatchSession({ command, sessionId: session.address.sessionId }),
      async commandLate(sessionId, command) {
        await host.dispatchSession({ command, sessionId });
      },
    };
  };

  const runHost = (
    run: Run,
    earlier: EarlierRun,
    journal: { readonly replay: RunReplay; readonly keep: Keep<unknown> },
  ): RunHost => {
    const { runId } = run.record;
    const { keep, replay } = journal;
    // A run's own hooks, like its deliveries, are named in the order its body opens them, so the
    // body run again after a restore listens where the sessions it reached reply.
    let hooks = 0;
    let deliveries = 0;
    return {
      runId: () => runId,
      createHook<T>(token = `${runHookPrefix(runId)}${String(hooks++)}`) {
        const hook = host.inboxes.openHook<T>(runId, token, { keep });
        void replay.opened(token);
        return hook;
      },
      sleep: (ms) => host.timers.until(Date.now() + ms),
      async resumeHook(token, payload, options) {
        // What its session heard from it before a restore isn't sent again.
        if (token === run.record.ownerInbox && !replay.send(payload)) return;
        await resumeHookWherever(token, payload, options);
      },
      resolveWorkflow: (workflowId) => bodies.get(workflowId) ?? FRAMEWORK_BODIES.get(workflowId),
      agentSessions: agentSessionsOver({
        deliveryId: (kind, sessionId) =>
          `agent-session:${runId}:${String(deliveries++)}:${sessionId}:${kind}`,
        local: localSessions(run, earlier),
        // Remote agents answer over HTTP, which this host doesn't serve them yet.
        remote: undefined,
      }),
    };
  };

  const launch = (snapshot: RunSnapshot, earlier: EarlierRun): void => {
    const record = runRecordOf(snapshot);
    const run: Run = {
      ended: false,
      record,
      snapshot: { ...snapshot, children: [...snapshot.children], received: [...snapshot.received] },
    };
    runs.set(record.runId, run);
    const replay = new RunReplay(earlier, (token, payload) => host.inboxes.replay(token, payload));
    // The run's journal: what its hooks receive, as far as it got when each arrived. What
    // arrives before its body listens, at its control hook or one of its own, waits for it.
    const keep: Keep<unknown> = async (token, payload) => {
      run.snapshot.received.push({ afterSent: replay.sent, payload, token });
    };
    const reservations = [
      host.inboxes.reserve(record.runId, { token: record.hookToken }, { keep }),
      host.inboxes.reserve(record.runId, { prefix: runHookPrefix(record.runId) }, { keep }),
    ];
    run.finished = runWorkflowToolRun(snapshot.input, runHost(run, earlier, { keep, replay }))
      .catch((error: unknown) => {
        logError(log, "workflow tool run failed", error, { runId: record.runId });
      })
      .finally(() => {
        run.ended = true;
        for (const release of reservations) release();
      });
  };

  return {
    async startRun(input) {
      const hookToken = workflowToolRunHookToken(input);
      const runId = `wrun_in_process_${createUlid()}`;
      // The run's input crosses the host's step boundary, as a started run's does.
      const crossed = await acrossStepBoundary<WorkflowToolRunInput>(host.stepBoundary, {
        ...input,
        hookToken,
      });
      launch({ children: [], input: crossed, received: [], runId }, { heard: 0, received: [] });
      return { hookToken, runId };
    },
    resume(run, heard) {
      // Its journal goes on from what it received before, which its body reads again.
      launch(run, { heard, received: run.received });
    },
    runEnded: (runId) => runs.get(runId)?.ended,
    cancelRun(runId, reason) {
      const run = runs.get(runId);
      if (run === undefined) return undefined;
      if (run.ended) return false;
      // Nothing here stops a run outright; `end` stops its body, and it settles cancelled.
      void host.inboxes.deliver(run.record.hookToken, { kind: "end", reason });
      return true;
    },
    unheard: (sessionId, heard) =>
      [...runs.values()]
        .filter(
          ({ ended, record, snapshot }) =>
            record.sessionId === sessionId && !(ended && heard(snapshot)),
        )
        .map(({ snapshot }) => ({
          ...snapshot,
          children: [...snapshot.children],
          received: [...snapshot.received],
        })),
    async finished(sessionId) {
      const started = [...runs.values()].filter(({ record }) => record.sessionId === sessionId);
      await Promise.all(started.map((run) => run.finished));
      return started.flatMap(({ snapshot }) => snapshot.children);
    },
    registerWorkflow(workflowId, body) {
      bodies.set(workflowId, body);
    },
  };
}

/** Everything about a run that its input and id determine. */
export function runRecordOf({
  input,
  runId,
}: Pick<RunSnapshot, "input" | "runId">): InProcessRunRecord {
  const taskId = input.entry.entryPoint === "execute" ? undefined : input.entry.taskId;
  return {
    callId: input.callId,
    hookToken: input.hookToken,
    kind:
      input.workflowId === agentToolServeWorkflowReference.workflowId
        ? "subagent"
        : taskId === undefined
          ? "workflow-tool"
          : "task",
    ownerInbox: input.owner.inbox,
    ref: {
      callId: input.callId,
      input: input.input,
      runId,
      sequence: input.session.turn.sequence,
      stepIndex: input.stepIndex,
      toolName: input.toolName,
      turnId: input.session.turn.id,
      ...(taskId !== undefined && { taskId }),
    },
    runId,
    sessionId: input.session.id,
    ...(taskId !== undefined && { taskId }),
  };
}
