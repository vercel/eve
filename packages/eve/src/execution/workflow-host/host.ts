import { getStepMetadata, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import { RunExpiredError, WorkflowRunNotFoundError } from "#compiled/@workflow/errors/index.js";
import type { DeliverHookPayload } from "#channel/types.js";
import {
  decodeDeliveryAddress,
  reveal,
  type Durable,
  type SessionStartInput,
  type SessionStatus,
  type StreamLine,
} from "#execution/durable.js";
import { installProcessEngine, type ProcessEngine } from "#execution/hosts.js";
import type { InitialWorkflowEntryInput } from "#execution/session/entry-input.js";
import type { AuthorizationCallbackPayload } from "#execution/session-inbox/inbox.js";
import type { SessionEventStore } from "#execution/session-event-store.js";
import { resumeSignInCallback } from "#execution/session-inbox/owner.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import {
  SESSION_INBOX_SESSION_ID_METADATA_KEY,
  logicalSessionToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { workflowEntryReference } from "#execution/workflow-references.js";
import { startWorkflowOnDeployment } from "#execution/workflow-runtime.js";
import {
  findConnectionEventOwner,
  retireConnectionEventOwner,
  startConnectionEventOwner,
} from "#runtime/connections/events/owner.js";
import {
  cancelRun,
  getRun,
  getWorld,
  resumeHook,
  type StartOptionsWithoutDeploymentId,
} from "#internal/workflow/runtime.js";
import type { Entities } from "#platform/entities.js";

export interface WorkflowRun {
  readonly runId: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly expiredAt: Date | undefined;
  readonly attributes: Readonly<Record<string, string | undefined>>;
}

export interface WorkflowSessionStart {
  readonly input: InitialWorkflowEntryInput;
  readonly options: StartOptionsWithoutDeploymentId;
}

export const workflowSessionEvents: SessionEventStore = {
  readable: (sessionId, startIndex) => getRun(sessionId).getReadable({ startIndex }),
  async tail(sessionId) {
    const readable = getRun(sessionId).getReadable();
    try {
      const [, tailIndex] = await Promise.all([
        workflowSessionEvents.assertReadable(sessionId),
        readable.getTailIndex(),
      ]);
      return tailIndex;
    } finally {
      await readable.cancel().catch(() => {});
    }
  },
  async assertReadable(sessionId) {
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

const deliverToWorkflow: Durable["deliver"] = async (to, payload) => {
  const address = decodeDeliveryAddress(to);
  if (address.kind === "hook") await resumeHook(address.token, payload);
  else if (address.kind === "session")
    await resumeSessionInbox(address.address, payload as DeliverHookPayload);
  else await resumeSignInCallback(address.token, payload as AuthorizationCallbackPayload);
};

async function startWorkflowSession({
  addresses,
  body,
  sessionId,
}: SessionStartInput): Promise<void> {
  const { input, options } = reveal<WorkflowSessionStart>(body);
  const [claimed] = addresses;
  const claimAddress = claimed === undefined ? undefined : decodeDeliveryAddress(claimed);
  if (claimAddress?.kind !== "session") {
    throw new Error("A Workflow session claims exactly its session inbox address at its start.");
  }
  await startWorkflowOnDeployment(
    workflowEntryReference,
    [input],
    input.ownerDeploymentId,
    options,
    (runId) => ({
      token: sessionInboxHookToken(logicalSessionToken(claimAddress.address)),
      metadata: { [SESSION_INBOX_SESSION_ID_METADATA_KEY]: runId },
    }),
    sessionId,
  );
}

const SESSION_STATUS: Readonly<Record<string, SessionStatus>> = {
  cancelled: "ended",
  completed: "ended",
  failed: "failed",
  pending: "running",
  running: "running",
};

async function workflowSessionStatus(sessionId: string): Promise<SessionStatus | undefined> {
  try {
    return SESSION_STATUS[await workflowRunStatus(sessionId)];
  } catch (error) {
    if (WorkflowRunNotFoundError.is(error)) return undefined;
    throw error;
  }
}

async function* readWorkflowStream(sessionId: string, from: number): AsyncIterable<StreamLine> {
  const reader = workflowSessionEvents.readable(sessionId, from).getReader();
  const decoder = new TextDecoder();
  let position = from;
  let buffered = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let end = buffered.indexOf("\n");
      while (end >= 0) {
        yield { position: position++, line: buffered.slice(0, end) };
        buffered = buffered.slice(end + 1);
        end = buffered.indexOf("\n");
      }
    }
    if (buffered.length > 0) yield { position, line: buffered };
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function workflowDurable(): Durable {
  return {
    start: startWorkflowSession,
    deliver: deliverToWorkflow,
    readStream: readWorkflowStream,
    tail: (sessionId) => workflowSessionEvents.tail(sessionId),
    status: workflowSessionStatus,
    connectionEvents: {
      start: (binding, bundle, signal) => startConnectionEventOwner(binding, bundle, signal),
      find: (bindingId) => findConnectionEventOwner(bindingId),
      retire: (bindingId) => retireConnectionEventOwner(bindingId),
    },
  };
}

export function workflowProcessEngine(platform: Entities): ProcessEngine {
  return {
    name: "workflow",
    durable: workflowDurable(),
    deploymentId: () => workflowDeploymentId(platform),
    runStatus: workflowRunStatus,
    cancelRun: cancelWorkflowRun,
    sessionEvents: workflowSessionEvents,
    callbackBaseUrl: () => workflowCallbackBaseUrl(platform),
    stepAttempt: workflowStepAttempt,
  };
}

export function installWorkflowEngine(platform: Entities): Durable {
  return installProcessEngine(workflowProcessEngine(platform)).durable;
}
