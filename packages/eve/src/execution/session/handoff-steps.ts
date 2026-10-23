import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";
import type { SessionHandoverPayload } from "#execution/session-inbox/inbox.js";
import { findSessionHookHolder } from "#execution/session-inbox/owner.js";
import { mapWithConcurrency } from "#shared/map-with-concurrency.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { deserializeContext, IncompatibleStateLayoutError } from "#context/serialize.js";
import type { SessionCheckpointMigration } from "#execution/session/checkpoint-migrations.js";
import { readDurableSession } from "#execution/durable-session-read.js";
import { isSessionStateIdleForHandoff } from "#execution/session/handoff-state.js";
import {
  SESSION_CHECKPOINT_VERSION,
  type SessionCheckpoint,
  type SessionOwnerActivation,
} from "#execution/session/handoff.js";
import { createLogger, logError } from "#internal/logging.js";
import { cancelRun, getRun, getWorld, resumeHook } from "#internal/workflow/runtime.js";
import {
  hasRunEnded,
  startWorkflowOnDeployment,
  workflowEntryReference,
} from "#execution/workflow-runtime.js";
import {
  SESSION_HANDOFF_VERSION,
  type HandoffWorkflowEntryInput,
  type SessionHandoffStart,
} from "#execution/session/entry-input.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  EVE_SESSION_ATTRIBUTE,
  EVE_VERSION_ATTRIBUTE,
  EVE_PREWARM_ATTRIBUTE,
} from "#execution/eve-workflow-attributes.js";
import { getResolvedRuntimeAgentNode } from "#runtime/graph.js";
import { owningSandboxDefinition } from "#runtime/sandbox/registry.js";
import {
  isRetiredSandboxSessionState,
  resolvePersistedSandboxSessionState,
} from "#sandbox/state.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";
import { walkCauseChain } from "#shared/errors.js";

const log = createLogger("execution.handoff");

export type SuccessorStartInput = SessionHandoffStart & {
  readonly activationToken: string;
  /** Original run whose stream stays the public session stream. */
  readonly anchorRunId: string;
  readonly attemptKey: string;
  readonly checkpoint: SessionCheckpoint;
  readonly hookTokens: readonly string[];
  /** The owner starting the successor, which hands over what it accepts meanwhile. */
  readonly sourceRunId: string;
  readonly targetDeploymentId: string;
};

export type SuccessorStart =
  | { readonly kind: "not-idle" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "started"; readonly runId: string };

/**
 * Starts a successor owner bound to the original session stream, unless this
 * deployment's code finds work in the checkpoint that cannot move yet, or the
 * World cannot move session addresses between runs without releasing them.
 */
export async function startSuccessorStep(input: SuccessorStartInput): Promise<SuccessorStart> {
  "use step";
  const { activationToken, anchorRunId, checkpoint, targetDeploymentId, ...start } = input;
  const { capabilities } = await getWorld();
  // Forced claims move the addresses; the attempt lease must outlive its candidate.
  if (capabilities?.hookForceClaim !== true || capabilities.hookRetention?.active !== true) {
    log.warn("session handoff unavailable: the Workflow world cannot force-claim hooks", {
      sessionId: anchorRunId,
    });
    return { kind: "unsupported" };
  }
  if (!isSessionStateIdleForHandoff(checkpoint)) return { kind: "not-idle" };
  const workflowInput: HandoffWorkflowEntryInput = {
    ...start,
    activationToken,
    checkpoint,
    handoffVersion: SESSION_HANDOFF_VERSION,
    kind: "handoff",
    ownerDeploymentId: targetDeploymentId,
    sessionWritable: getRun(anchorRunId).getWritable<Uint8Array>(),
    sessionId: anchorRunId,
  };
  // The successor is stamped with this eve version at start, because the
  // queue guard runs before it boots. Single-build Worlds share this version;
  // deployment-affine Worlds bypass the guard and the successor records its
  // own version at boot.
  const run = await startWorkflowOnDeployment(
    workflowEntryReference,
    [workflowInput],
    targetDeploymentId,
    checkpoint.retention === undefined
      ? undefined
      : { experimental_retention: checkpoint.retention },
  );
  return { kind: "started", runId: run.runId };
}

/** Whether `runId` has ended; a run not readable yet has not. */
export async function hasRunEndedStep(input: { readonly runId: string }): Promise<boolean> {
  "use step";
  return await hasRunEnded(input.runId);
}

export type SessionCheckpointValidation =
  | { readonly kind: "valid" }
  | { readonly kind: "incompatible"; readonly reason: "checkpoint-version" }
  /** The source no longer holds every address it handed over, so none may be taken. */
  | { readonly kind: "source-gone" };

/**
 * Validates an upgraded checkpoint, resolves the target deployment's compiled
 * bundle, and records this owner's identity before it claims any hook.
 *
 * A checkpoint this deployment cannot read is a settled answer, not a fault,
 * so it returns rather than throws: retrying the step can never change it.
 */
export async function prepareSuccessorStep(input: {
  /** Absent for version 1 sources, which predate the field. */
  readonly handoffVersion: number | undefined;
  readonly migration: SessionCheckpointMigration;
  readonly sessionId: string;
  /** Version 3: the run that still holds the session and the addresses it hands over. */
  readonly source?: { readonly runId: string; readonly hookTokens: readonly string[] };
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
  // The runtime ignores a retired record, so it must not block the handoff.
  if (
    sandboxState !== null &&
    sandboxState !== undefined &&
    !isRetiredSandboxSessionState(sandboxState)
  ) {
    const definition = owningSandboxDefinition(
      getResolvedRuntimeAgentNode(bundle.graph, bundle.nodeId).sandboxRegistry.sandbox,
    );
    if (definition.kind !== "independent") {
      throw new Error("Session checkpoint sandbox has no resolved provider.");
    }
    const provider = getSandboxEnvironmentRuntime(definition.environment);
    const resolved = resolvePersistedSandboxSessionState(sandboxState, provider);
    if (
      resolved?.providerName !== provider.providerName ||
      resolved.stateProtocolVersion !== provider.stateProtocolVersion
    ) {
      throw new Error("Session checkpoint sandbox provider state is incompatible.");
    }
  }
  if (!isSessionStateIdleForHandoff(checkpoint)) {
    throw new Error("Session checkpoint contains pending work and cannot be handed off.");
  }
  if (input.source !== undefined && !(await holdsEveryAddress(input.source))) {
    return { kind: "source-gone" };
  }
  await recordSessionOwner(input.sessionId);
  // Owners on releases before version 3 release their addresses first. This
  // line shows when none remain, which is when that compatibility can go.
  if ((input.handoffVersion ?? 1) < SESSION_HANDOFF_VERSION) {
    log.info("session moved from an owner that releases its addresses first", {
      handoffVersion: input.handoffVersion ?? 1,
      sessionId: input.sessionId,
    });
  }
  return { kind: "valid" };
}

/**
 * Whether `source.runId` still holds every address. A delayed successor whose
 * source has ended could otherwise force-claim a channel alias that a new
 * session reuses. The source can still end between this check and the claims
 * that follow, but that window is one step rather than a queue delay.
 */
async function holdsEveryAddress(source: {
  readonly runId: string;
  readonly hookTokens: readonly string[];
}): Promise<boolean> {
  // A session may hold up to 256 addresses.
  const holders = await mapWithConcurrency(source.hookTokens, 16, (token) =>
    findSessionHookHolder(sessionInboxHookToken(token)),
  );
  return holders.every((holder) => holder?.runId === source.runId);
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
 * Records the identity of a legacy importer before it claims any hook;
 * handoff successors do the same inside `prepareSuccessorStep`. Ingress reads
 * `$eve.version` to decide whether the owner can run, so a missing value would
 * strand a healthy session. The value comes from this step's code, not the
 * previous owner's. Unlike observability attributes, a failed write fails the
 * boot.
 */
export async function recordSessionOwnerStep(input: { readonly sessionId: string }): Promise<void> {
  "use step";
  await recordSessionOwner(input.sessionId);
}

async function recordSessionOwner(sessionId: string): Promise<void> {
  const { setAttributes } = await import("#compiled/@workflow/core/index.js");
  await setAttributes(
    {
      [EVE_SESSION_ATTRIBUTE]: sessionId,
      [EVE_PREWARM_ATTRIBUTE]: "1",
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
  try {
    await resumeHook(input.token, input.activation);
  } catch (error) {
    // The owner already settled the attempt and disposed the hook.
    if (!HookNotFoundError.is(error)) throw error;
  }
}

/** Makes a takeover with no attempt open visible: every forced claim belongs to one. */
export async function reportSessionTakenOverOutsideAttemptStep(input: {
  readonly sessionId: string;
}): Promise<void> {
  "use step";
  log.error("session taken over with no handoff attempt open; this run leaves without finalizing", {
    sessionId: input.sessionId,
  });
}

/**
 * Makes a move whose handover part keeps failing visible; the owner keeps
 * retrying, because dropping the part would lose an accepted message.
 */
export async function reportHandoverPartStuckStep(input: {
  readonly attemptKey: string;
  readonly error: string | undefined;
  readonly failures: number;
  readonly index: number;
  readonly sessionId: string;
}): Promise<void> {
  "use step";
  log.warn("session handover part keeps failing; the previous owner keeps retrying", input);
}

/**
 * Sends one handover part through the stable session address, which reaches
 * whichever run owns the session. A part that keeps failing fails the step,
 * for the caller to retry until it is delivered.
 */
export async function sendSessionHandoverPartStep(input: {
  readonly part: Omit<SessionHandoverPayload, "kind">;
  readonly sessionId: string;
}): Promise<"delivered" | "session-ended"> {
  "use step";
  try {
    await resumeHook(sessionInboxHookToken(sessionCommandHookToken(input.sessionId)), {
      ...input.part,
      kind: "handover",
    } satisfies SessionHandoverPayload);
    return "delivered";
  } catch (error) {
    // The session has ended, so nothing waits for these payloads.
    if (HookNotFoundError.is(error)) return "session-ended";
    throw error;
  }
}

export async function signalSessionAnchorStep(input: {
  readonly result: { readonly output: unknown };
  readonly token: string;
}): Promise<void> {
  "use step";
  await resumeHook(input.token, input.result);
}
