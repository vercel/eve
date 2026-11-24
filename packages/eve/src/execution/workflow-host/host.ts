import { getStepMetadata, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import { RunExpiredError, WorkflowRunNotFoundError } from "#compiled/@workflow/errors/index.js";
import { readStreamLines, type Durable, type SessionStatus } from "#execution/durable.js";
import {
  installProcessEngine,
  replaceProcessEngine,
  type ProcessEngine,
  type ProcessHosts,
} from "#execution/hosts.js";
import type { SessionEventStore } from "#execution/session-event-store.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import {
  assertRunnableSessionInbox,
  assertRunnableSessionOwner,
  findSessionHookHolder,
} from "#execution/session-inbox/owner.js";
import {
  deliverToWorkflow,
  readWorkflowChildBinding,
  replacingStranded,
  resumeWorkflowAddress,
  startWorkflowSession,
  workflowSessionFor,
} from "#execution/workflow-host/session-durable.js";
import {
  findConnectionEventOwner,
  retireConnectionEventOwner,
  startConnectionEventOwner,
} from "#runtime/connections/events/owner.js";
import { cancelRun, getRun, getWorld } from "#internal/workflow/runtime.js";
import { processPlatform, processPlatformNow } from "#platform/process.js";
import type { Entities } from "#platform/entities.js";

export interface WorkflowRun {
  readonly runId: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly expiredAt: Date | undefined;
  readonly attributes: Readonly<Record<string, string | undefined>>;
}

function commandInboxToken(sessionId: string): string {
  return sessionInboxHookToken(sessionCommandHookToken(sessionId));
}

async function assertHistoryReadable(sessionId: string): Promise<void> {
  const world = await getWorld();
  const run = await world.runs.get(sessionId, { resolveData: "none" });
  if (run.expiredAt !== undefined && run.expiredAt.getTime() <= Date.now()) {
    throw new RunExpiredError(
      "Session history is no longer available.",
      sessionId,
      run.status,
      run.expiredAt,
    );
  }
}

export const workflowSessionEvents: SessionEventStore = {
  readable: (sessionId, startIndex) => getRun(sessionId).getReadable({ startIndex }),
  async tail(sessionId) {
    const readable = getRun(sessionId).getReadable();
    try {
      const [, tailIndex] = await Promise.all([
        assertHistoryReadable(sessionId),
        readable.getTailIndex(),
      ]);
      return tailIndex;
    } finally {
      await readable.cancel().catch(() => {});
    }
  },
  async assertFollowable(sessionId) {
    await Promise.all([
      replacingStranded(() => assertRunnableSessionInbox(commandInboxToken(sessionId))),
      assertHistoryReadable(sessionId),
    ]);
  },
};

export async function workflowDeploymentId(platform: Entities): Promise<string> {
  return platform.deployment.deploymentId() ?? (await (await getWorld()).getDeploymentId());
}

export async function findWorkflowRun(runId: string): Promise<WorkflowRun | undefined> {
  try {
    const run = await (await getWorld()).runs.get(runId);
    return {
      attributes: run.attributes,
      createdAt: run.createdAt,
      expiredAt: run.expiredAt,
      runId: run.runId,
      status: run.status,
    };
  } catch (error) {
    if (WorkflowRunNotFoundError.is(error) || RunExpiredError.is(error)) return undefined;
    throw error;
  }
}

export async function workflowRunStatus(runId: string): Promise<string> {
  return await getRun(runId).status;
}

export async function cancelWorkflowRun(runId: string, reason: string): Promise<void> {
  await cancelRun(await getWorld(), runId, { cancelReason: reason });
}

export function workflowCallbackBaseUrl(platform: Entities): string | undefined {
  try {
    const { url } = getWorkflowMetadata();
    return typeof url === "string" ? resolveWorkflowCallbackBaseUrl(url, platform) : undefined;
  } catch (error) {
    if (error instanceof Error && error.name === "NotInWorkflowOrStepContextError") {
      return undefined;
    }
    throw error;
  }
}

export function workflowStepAttempt(): number | undefined {
  try {
    return getStepMetadata().attempt;
  } catch (error) {
    if (error instanceof Error && error.name === "NotInStepContextError") return undefined;
    throw error;
  }
}

const UNHELD_SESSION_STATUS: Readonly<Record<string, SessionStatus>> = {
  cancelled: "ended",
  completed: "ended",
  failed: "failed",
  pending: "ended",
  running: "ended",
};

async function workflowSessionStatus(sessionId: string): Promise<SessionStatus | undefined> {
  const holder = await findSessionHookHolder(commandInboxToken(sessionId));
  if (holder !== undefined) {
    await replacingStranded(() => assertRunnableSessionOwner(holder));
    return "running";
  }
  return await workflowRunStatus(sessionId).then(
    (status) => UNHELD_SESSION_STATUS[status],
    () => undefined,
  );
}

export function workflowDurable(): Durable {
  return {
    start: startWorkflowSession,
    deliver: deliverToWorkflow,
    sessionFor: workflowSessionFor,
    readStream: (sessionId, from) =>
      readStreamLines(workflowSessionEvents.readable(sessionId, from), from),
    tail: (sessionId) => workflowSessionEvents.tail(sessionId),
    status: workflowSessionStatus,
    readChildBinding: readWorkflowChildBinding,
    connectionEvents: {
      start: (binding, bundle, signal) => startConnectionEventOwner(binding, bundle, signal),
      find: (bindingId) => findConnectionEventOwner(bindingId),
      retire: (bindingId) => retireConnectionEventOwner(bindingId),
    },
  };
}

function workflowProcessEngine(platform: {
  now(): Entities;
  resolved(): Promise<Entities>;
}): ProcessEngine {
  return {
    name: "workflow",
    durable: workflowDurable(),
    resume: resumeWorkflowAddress,
    deploymentId: async () => await workflowDeploymentId(await platform.resolved()),
    runStatus: workflowRunStatus,
    cancelRun: cancelWorkflowRun,
    sessionEvents: workflowSessionEvents,
    callbackBaseUrl: () => workflowCallbackBaseUrl(platform.now()),
    stepAttempt: workflowStepAttempt,
  };
}

const APP_PLATFORM = (platform: Entities) => ({
  now: () => platform,
  resolved: async () => platform,
});

export function fallbackWorkflowEngine(): ProcessEngine {
  return workflowProcessEngine({ now: processPlatformNow, resolved: processPlatform });
}

export function installWorkflowEngine(hosts: ProcessHosts, platform: Entities): Durable {
  return replaceProcessEngine(hosts, workflowProcessEngine(APP_PLATFORM(platform))).durable;
}

export function installFallbackWorkflowEngine(hosts: ProcessHosts): void {
  installProcessEngine(hosts, fallbackWorkflowEngine());
}
