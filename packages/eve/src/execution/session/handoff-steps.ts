import { deserializeContext } from "#context/serialize.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import {
  SESSION_CHECKPOINT_VERSION,
  type SessionCheckpoint,
  type SessionOwnerActivation,
} from "#execution/session/handoff.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { getResolvedRuntimeAgentNode } from "#runtime/graph.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";
import { isObject } from "#shared/guards.js";
import { hasWorkingTasks } from "#tasks/state.js";
import { readTaskTable } from "#tasks/table.js";

/** Parses retained work with this deployment's code before deciding whether it can move. */
export function isSessionStateIdleForHandoff(sessionState: DurableSessionState): boolean {
  const { state } = readDurableSession(sessionState);

  // These registries are deleted when work settles. Their ordinary readers
  // tolerate malformed values as absent; that must not authorize a handoff.
  const pendingKeys = [
    "eve.runtime.pendingAuthorization",
    "eve.runtime.pendingInputBatch",
    "eve.runtime.pendingCoordinationBatch",
    "eve.runtime.deferredStepInput",
    "eve.harness.pendingWorkflowInterrupt",
  ];
  if (pendingKeys.some((key) => state?.[key] !== undefined)) return false;
  const batches = state?.["eve.runtime.pendingInputBatches"];
  if (batches !== undefined && (!Array.isArray(batches) || batches.length > 0)) return false;
  const proxyRequests = state?.["eve.runtime.proxyInputRequests"];
  if (
    proxyRequests !== undefined &&
    (!isObject(proxyRequests) || Object.keys(proxyRequests).length > 0)
  )
    return false;
  // An unreadable task record may be a working task this deployment cannot see.
  if (readTaskTable(state).lost.length > 0) return false;
  return !hasWorkingTasks({ state });
}

/** Reads durable work using the source deployment's handoff contract. */
export async function isSessionIdleForHandoffStep(input: {
  readonly sessionState: DurableSessionState;
}): Promise<boolean> {
  "use step";
  return isSessionStateIdleForHandoff(input.sessionState);
}

/** Validates a checkpoint and resolves the target deployment's compiled bundle. */
export async function validateSessionCheckpointStep(input: {
  readonly checkpoint: SessionCheckpoint;
}): Promise<void> {
  "use step";
  const { checkpoint } = input;
  if (checkpoint.version !== SESSION_CHECKPOINT_VERSION) {
    throw new Error(
      `Unsupported session checkpoint version ${JSON.stringify(checkpoint.version)}; this deployment reads version ${SESSION_CHECKPOINT_VERSION}. Start a new session on this deployment.`,
    );
  }
  const timeout = checkpoint.sessionTimeoutMs;
  if (
    timeout !== false &&
    (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0)
  )
    throw new Error("Session checkpoint contains an invalid timeout duration.");
  const context = await deserializeContext(checkpoint.serializedContext);
  const bundle = context.require(BundleKey);
  const session = readDurableSession(checkpoint.sessionState);
  const sandboxState = session.sandboxState?.session;
  if (sandboxState !== null && sandboxState !== undefined) {
    const definition =
      getResolvedRuntimeAgentNode(bundle.graph, bundle.nodeId).sandboxRegistry.sandbox.inheritance
        ?.definition ??
      getResolvedRuntimeAgentNode(bundle.graph, bundle.nodeId).sandboxRegistry.sandbox.definition;
    if (definition.kind !== "independent") {
      throw new Error("Session checkpoint sandbox has no resolved provider.");
    }
    const provider = getSandboxEnvironmentRuntime(definition.environment);
    if (
      sandboxState.providerName !== provider.providerName ||
      sandboxState.stateProtocolVersion !== provider.stateProtocolVersion
    ) {
      throw new Error("Session checkpoint sandbox provider state is incompatible.");
    }
  }
  if (!isSessionStateIdleForHandoff(checkpoint.sessionState)) {
    throw new Error("Session checkpoint contains pending work and cannot be handed off.");
  }
}

export async function signalSessionOwnerActivationStep(input: {
  readonly activation: SessionOwnerActivation;
  readonly token: string;
}): Promise<void> {
  "use step";
  await resumeHook(input.token, input.activation);
}

export async function signalSessionAnchorStep(input: {
  readonly result: { readonly output: unknown };
  readonly token: string;
}): Promise<void> {
  "use step";
  await resumeHook(input.token, input.result);
}
