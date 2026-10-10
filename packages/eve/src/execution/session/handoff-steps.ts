import { queuedInput, storedProjection } from "#harness/session-machine/view.js";
import { openInputs, openSignIns } from "#protocol/session-projection.js";
import { getBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { holdsHitlRequests } from "#harness/hitl/index.js";
import {
  EntityConflictError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";
import { deserializeContext, IncompatibleStateLayoutError } from "#context/serialize.js";
import type { SessionCheckpointMigration } from "#execution/session/checkpoint-migrations.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import {
  SESSION_CHECKPOINT_VERSION,
  type SessionOwnerActivation,
} from "#execution/session/handoff.js";
import { createLogger, logError } from "#internal/logging.js";
import { cancelRun, getWorld, resumeHook } from "#internal/workflow/runtime.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  EVE_SESSION_ATTRIBUTE,
  EVE_VERSION_ATTRIBUTE,
} from "#execution/eve-workflow-attributes.js";
import { getResolvedRuntimeAgentNode } from "#runtime/graph.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";
import { walkCauseChain } from "#shared/errors.js";

const log = createLogger("execution.handoff");

/** Parses retained work with this deployment's code before deciding whether it can move. */
export function isSessionStateIdleForHandoff(input: {
  readonly sessionState: DurableSessionState;
}): boolean {
  const { state } = readDurableSession(input.sessionState);
  // Decoding the run registry rejects corrupt state before any busy-work shortcut.
  const workflowToolRuns = getBlockingWorkflowToolRuns(state);

  // These registries are deleted when work settles. Their ordinary readers
  // tolerate malformed values as absent; that must not authorize a handoff.
  if (holdsHitlRequests(state)) return false;
  const pendingKeys = [
    "eve.runtime.pendingInputBatch",
    "eve.runtime.pendingCoordinationBatch",
    "eve.runtime.deferredStepInput",
    "eve.harness.pendingWorkflowInterrupt",
  ];
  if (pendingKeys.some((key) => state?.[key] !== undefined)) return false;
  const batches = state?.["eve.runtime.pendingInputBatches"];
  if (batches !== undefined && (!Array.isArray(batches) || batches.length > 0)) return false;
  const projection = storedProjection(state);
  return (
    workflowToolRuns.length === 0 &&
    projection.activeTurnId === undefined &&
    openInputs(projection).length === 0 &&
    openSignIns(projection).length === 0 &&
    queuedInput(state) === undefined
  );
}

/** Reads durable work using the source deployment's handoff contract. */
export async function isSessionIdleForHandoffStep(input: {
  readonly sessionState: DurableSessionState;
}): Promise<boolean> {
  "use step";
  return isSessionStateIdleForHandoff(input);
}

export type SessionCheckpointValidation =
  | { readonly kind: "valid" }
  | { readonly kind: "incompatible"; readonly reason: "checkpoint-version" };

/**
 * Validates an upgraded checkpoint and resolves the target deployment's
 * compiled bundle.
 *
 * A checkpoint this deployment cannot read is a settled answer, not a fault,
 * so it returns rather than throws: retrying the step can never change it.
 */
export async function validateSessionCheckpointStep(input: {
  readonly migration: SessionCheckpointMigration;
  readonly sessionId: string;
}): Promise<SessionCheckpointValidation> {
  "use step";
  const { migration } = input;
  const unreadable = (detail: string): SessionCheckpointValidation => {
    log.warn("session handoff refused: this deployment cannot read the checkpoint", {
      detail,
      readableCheckpointVersion: SESSION_CHECKPOINT_VERSION,
      sessionId: input.sessionId,
    });
    return { kind: "incompatible", reason: "checkpoint-version" };
  };
  if (migration.kind === "incompatible") return unreadable(migration.detail);
  const { checkpoint } = migration;
  const timeout = checkpoint.sessionTimeoutMs;
  if (
    timeout !== false &&
    (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0)
  )
    throw new Error("Session checkpoint contains an invalid timeout duration.");
  let context: Awaited<ReturnType<typeof deserializeContext>>;
  try {
    context = await deserializeContext(checkpoint.serializedContext);
  } catch (error) {
    if (error instanceof IncompatibleStateLayoutError) return unreadable(error.message);
    throw error;
  }
  const bundle = context.require(BundleKey);
  const session = readDurableSession(checkpoint.sessionState);
  const sandboxState = session.sandboxState?.session;
  // A record without `providerName` predates the provider redesign (eve 0.64)
  // and is ignored at runtime, so it must not block the handoff.
  if (
    sandboxState !== null &&
    sandboxState !== undefined &&
    sandboxState.providerName !== undefined
  ) {
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
  if (!isSessionStateIdleForHandoff(checkpoint)) {
    throw new Error("Session checkpoint contains pending work and cannot be handed off.");
  }
  return { kind: "valid" };
}

/**
 * Stops idle subagent sessions an older owner kept resumable, after this owner
 * activates. Best effort: a child that cannot be stopped ends at its own timeout.
 */
export async function stopUntrackedChildSessionsStep(input: {
  readonly runIds: readonly string[];
  readonly sessionId: string;
}): Promise<void> {
  "use step";
  const world = await getWorld();
  for (const runId of input.runIds) {
    if (runId === input.sessionId) continue;
    try {
      await cancelRun(world, runId, { cancelReason: "Session upgraded" });
    } catch (error) {
      const settled = [...walkCauseChain(error)].some(
        (cause) =>
          EntityConflictError.is(cause) ||
          RunExpiredError.is(cause) ||
          WorkflowRunNotFoundError.is(cause),
      );
      if (!settled) {
        logError(log, "could not stop a subagent session after handoff", error, {
          childRunId: runId,
          sessionId: input.sessionId,
        });
      }
    }
  }
}

/** Records why the owner kept a session it tried to move, so a stuck handoff is visible. */
export async function reportSessionHandoffRetainedStep(input: {
  readonly error?: string;
  readonly reason: "activation-failed" | "checkpoint-incompatible";
  readonly sessionId: string;
  readonly sourceDeploymentId: string;
  readonly targetDeploymentId: string;
}): Promise<void> {
  "use step";
  log.warn("session handoff failed; the current owner keeps the session", {
    ...input,
    checkpointVersion: SESSION_CHECKPOINT_VERSION,
  });
}

/**
 * Records the identity of an owner that this deployment's code did not start
 * (a handoff successor or a legacy importer) before it claims any hook:
 * ingress reads `$eve.version` to decide whether the owner can run, so a
 * missing value would strand a healthy session. The value comes from this
 * step's code, not the previous owner's. Unlike observability attributes, a
 * failed write fails the boot.
 */
export async function recordSessionOwnerStep(input: { readonly sessionId: string }): Promise<void> {
  "use step";
  const { setAttributes } = await import("#compiled/@workflow/core/index.js");
  await setAttributes(
    {
      [EVE_SESSION_ATTRIBUTE]: input.sessionId,
      [EVE_VERSION_ATTRIBUTE]: resolveInstalledPackageInfo().version,
    },
    { allowReservedAttributes: true },
  );
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
