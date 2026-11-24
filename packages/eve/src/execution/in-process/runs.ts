import type { RouteHosts } from "#execution/hosts.js";
import type { Runtime } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import {
  agentSessionsOver,
  type LocalAgentSessions,
} from "#execution/agent-sessions/sessions-over.js";
import { FRAMEWORK_WORKFLOW_BODIES } from "#execution/framework-workflow-bodies.js";
import type { SessionRuntimeConfig } from "#execution/initial-entry.js";
import type { RunHook, RunHost } from "#execution/run-host.js";
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

const log = createLogger("execution.in-process.runs");

export interface InProcessRunsHost {
  readonly hosts: RouteHosts;
  readonly inboxes: MemoryInboxRegistry;
  readonly stepBoundary: StepBoundary;
  readonly timers: InProcessTimers;
  readonly toolStubs: ToolStubHost;
  runtimeFor(config: SessionRuntimeConfig): Runtime;
  readonly dispatchSession: Runtime["dispatchSession"];
}

export interface InProcessRuns {
  readonly startRun: StartWorkflowToolRun;
  runEnded(runId: string): boolean | undefined;
  cancelRun(runId: string, reason: string): boolean | undefined;
  registerWorkflow(workflowId: string, body: WorkflowFunction): void;
  stopAll(reason: string): Promise<void>;
}

export type WorkflowFunction = (...args: never[]) => unknown;

const FRAMEWORK_BODIES = new Map(
  FRAMEWORK_WORKFLOW_BODIES.map(({ body, workflowId }) => [workflowId, body]),
);

interface Run {
  readonly runId: string;
  readonly hookToken: string;
  ended: boolean;
  finished?: Promise<void>;
}

const runHookPrefix = (runId: string) => `eve:in-process:${runId}:`;

const KEEP_NOTHING: Keep<unknown> = async () => {};

export function createInProcessRuns(host: InProcessRunsHost): InProcessRuns {
  const runs = new Map<string, Run>();
  const bodies = new Map<string, WorkflowFunction>();

  const localSessions: LocalAgentSessions = {
    async start(prepared, { context }) {
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
    const createHook = <T>(token = `${runHookPrefix(runId)}${String(hooks++)}`): RunHook<T> =>
      host.inboxes.openHook<T>(runId, token, { keep: KEEP_NOTHING });
    return {
      runId: () => runId,
      createHook,
      createRemoteReplyHook: async <T>() => createHook<T>(),
      sleep: (ms) => host.timers.until(Date.now() + ms),
      resumeHook: async (token, payload, options) =>
        await resumeHookWherever(host.hosts, token, payload, options),
      resolveWorkflow: (workflowId) => bodies.get(workflowId) ?? FRAMEWORK_BODIES.get(workflowId),
      toolStubs: host.toolStubs,
      agentSessions: agentSessionsOver({
        deliveryId: (kind, sessionId) =>
          `agent-session:${runId}:${String(deliveries++)}:${sessionId}:${kind}`,
        local: localSessions,
        remote: undefined,
      }),
    };
  };

  return {
    async startRun(input) {
      const hookToken = workflowToolRunHookToken(input);
      const runId = `wrun_in_process_${createUlid()}`;
      const crossed = await acrossStepBoundary<WorkflowToolRunInput>(host.stepBoundary, {
        ...input,
        hookToken,
      });
      const run: Run = { ended: false, hookToken, runId };
      runs.set(runId, run);
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
