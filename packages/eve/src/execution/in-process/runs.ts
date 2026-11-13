import type { Runtime } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import {
  agentSessionsOver,
  type LocalAgentSessions,
} from "#execution/agent-sessions/sessions-over.js";
import { FRAMEWORK_WORKFLOW_BODIES } from "#execution/framework-workflow-bodies.js";
import type { SessionRuntimeConfig } from "#execution/initial-entry.js";
import type { RunHost } from "#execution/run-host.js";
import type { ToolStubHost } from "#execution/tool-stub-host.js";
import { resumeHookWherever } from "#execution/tools/workflow/resume-hook.js";
import { runWorkflowToolRun } from "#execution/tools/workflow/run.js";
import {
  workflowToolRunHookToken,
  type StartWorkflowToolRun,
} from "#execution/tools/workflow/start.js";
import type { WorkflowToolRunInput } from "#execution/tools/workflow/types.js";
import { createLogger, logError } from "#internal/logging.js";
import { createUlid } from "#shared/ulid.js";
import type { Keep, MemoryInboxRegistry } from "./inbox-transport.js";
import { acrossStepBoundary, type StepBoundary } from "./step-boundary.js";
import type { InProcessTimers } from "./timers.js";

// Workflow tool runs in this process: subagents, the `agent` tool, tasks, and workflow tools.
// Each run is the same owner loop and body Workflow runs (`runWorkflowToolRun`), as a task here.
// Its hooks are addresses in the host's memory inbox, which it reserves as it starts; its sleeps
// are the host's timers; and the sessions its `ctx.agent` opens are sessions of the host's
// runtimes. What it sends its session, and what the session sends it, travel by hook token, as
// on Workflow. A run doesn't outlive the process.

const log = createLogger("execution.in-process.runs");

/** What the runs need from the host they run on. */
export interface InProcessRunsHost {
  readonly inboxes: MemoryInboxRegistry;
  /** What a started run's input crosses, as a durable run's does its host's serializer. */
  readonly stepBoundary: StepBoundary;
  readonly timers: InProcessTimers;
  /** Serves a stubbed eval's tool stubs to its runs' calls. */
  readonly toolStubs: ToolStubHost;
  /** The runtime that runs sessions of one agent, or one node of a compiled agent, here. */
  runtimeFor(config: SessionRuntimeConfig): Runtime;
  /** Sends a command to a session this host runs. */
  readonly dispatchSession: Runtime["dispatchSession"];
}

export interface InProcessRuns {
  readonly startRun: StartWorkflowToolRun;
  /** Whether `runId` ended, or `undefined` when it never ran here. */
  runEnded(runId: string): boolean | undefined;
  /** Stops `runId`: `true` when it was running, `undefined` when it never ran here. */
  cancelRun(runId: string, reason: string): boolean | undefined;
  /** Makes a workflow tool's body available to runs here, under its `workflowId`. */
  registerWorkflow(workflowId: string, body: WorkflowFunction): void;
  /** Stops every run still running, and resolves once each body returned. */
  stopAll(reason: string): Promise<void>;
}

/** A workflow tool's body, its `"use workflow"` function's plain twin: a function or a generator. */
export type WorkflowFunction = (...args: never[]) => unknown;

/** eve's own workflow bodies, by workflow id. */
const FRAMEWORK_BODIES = new Map(
  FRAMEWORK_WORKFLOW_BODIES.map(({ body, workflowId }) => [workflowId, body]),
);

/** A run here, and whether it ended. */
interface Run {
  readonly runId: string;
  readonly hookToken: string;
  ended: boolean;
  /** Resolves once its body returned, however it ended. */
  finished?: Promise<void>;
}

/** The `n`th hook a run's body opens without naming it. */
const runHookPrefix = (runId: string) => `eve:in-process:${runId}:`;

/** A run keeps nothing of what its hooks receive: it doesn't outlive the process. */
const KEEP_NOTHING: Keep<unknown> = async () => {};

export function createInProcessRuns(host: InProcessRunsHost): InProcessRuns {
  const runs = new Map<string, Run>();
  const bodies = new Map<string, WorkflowFunction>();

  /** The sessions a run's body opens, on the host's runtime for each child's agent. */
  const localSessions: LocalAgentSessions = {
    async start(prepared, { context }) {
      // The child inherits none of the calling session's lineage, as on Workflow.
      const started = await contextStorage.run(
        new ContextContainer({ localDevRequest: context.localDevRequest }),
        () => host.runtimeFor(prepared.runtime).createSession(prepared.runInput),
      );
      return { address: prepared.address(started.sessionId), deliveryId: prepared.deliveryId };
    },
    command: async (session, command) =>
      await host.dispatchSession({ command, sessionId: session.address.sessionId }),
    async commandLate(sessionId, command) {
      await host.dispatchSession({ command, sessionId });
    },
  };

  const runHost = (runId: string): RunHost => {
    let hooks = 0;
    let deliveries = 0;
    return {
      runId: () => runId,
      createHook<T>(token = `${runHookPrefix(runId)}${String(hooks++)}`) {
        return host.inboxes.openHook<T>(runId, token, { keep: KEEP_NOTHING });
      },
      sleep: (ms) => host.timers.until(Date.now() + ms),
      resumeHook: async (token, payload, options) =>
        await resumeHookWherever(token, payload, options),
      resolveWorkflow: (workflowId) => bodies.get(workflowId) ?? FRAMEWORK_BODIES.get(workflowId),
      toolStubs: host.toolStubs,
      agentSessions: agentSessionsOver({
        deliveryId: (kind, sessionId) =>
          `agent-session:${runId}:${String(deliveries++)}:${sessionId}:${kind}`,
        local: localSessions,
        // Remote agents answer over HTTP, which this host doesn't serve them.
        remote: undefined,
      }),
    };
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
      const run: Run = { ended: false, hookToken, runId };
      runs.set(runId, run);
      // What arrives before its body listens, at its control hook or one of its own, waits.
      const reservations = [
        host.inboxes.reserve(runId, { token: hookToken }, { keep: KEEP_NOTHING }),
        host.inboxes.reserve(runId, { prefix: runHookPrefix(runId) }, { keep: KEEP_NOTHING }),
      ];
      run.finished = runWorkflowToolRun(crossed, runHost(runId))
        .catch((error: unknown) => {
          logError(log, "workflow tool run failed", error, { runId });
        })
        .finally(() => {
          run.ended = true;
          for (const release of reservations) release();
        });
      return { hookToken, runId };
    },
    runEnded: (runId) => runs.get(runId)?.ended,
    cancelRun(runId, reason) {
      const run = runs.get(runId);
      if (run === undefined) return undefined;
      if (run.ended) return false;
      // Nothing here stops a run outright; `end` stops its body, and it settles cancelled.
      void host.inboxes.deliver(run.hookToken, { kind: "end", reason });
      return true;
    },
    registerWorkflow(workflowId, body) {
      bodies.set(workflowId, body);
    },
    async stopAll(reason) {
      const live = [...runs.values()].filter((run) => !run.ended);
      for (const run of live) void host.inboxes.deliver(run.hookToken, { kind: "end", reason });
      await Promise.all(live.map((run) => run.finished));
    },
  };
}
