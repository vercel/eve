import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
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
import { createLogger } from "#internal/logging.js";
import { getWorld, resumeHook } from "#internal/workflow/runtime.js";
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
import { traceSessionHandover } from "#execution/session/handover-tracing.js";
import { readSessionStreamTailIndex } from "#execution/session-event-stream.js";

const log = createLogger("execution.handoff");

export type SuccessorStartInput = SessionHandoffStart & {
  readonly activationToken: string;
  readonly anchorRunId: string;
  readonly attemptKey: string;
  readonly checkpoint: SessionCheckpoint;
  readonly hookTokens: readonly string[];
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly sourceRunId: string;
  readonly targetDeploymentId: string;
};

export type SuccessorStart =
  | { readonly kind: "not-idle" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "started"; readonly runId: string };

export async function startSuccessorStep(input: SuccessorStartInput): Promise<SuccessorStart> {
  "use step";
  const {
    activationToken,
    anchorRunId,
    checkpoint,
    sessionWritable,
    targetDeploymentId,
    ...start
  } = input;
  const { capabilities } = await getWorld();
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
    sessionWritable,
    sessionId: anchorRunId,
  };
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

export async function hasRunEndedStep(input: { readonly runId: string }): Promise<boolean> {
  "use step";
  return await hasRunEnded(input.runId);
}

export type SessionCheckpointValidation =
  | { readonly kind: "valid" }
  | { readonly kind: "incompatible"; readonly reason: "checkpoint-version" }
  | { readonly kind: "source-gone" };

export async function prepareSuccessorStep(input: {
  readonly migration: Exclude<SessionCheckpointMigration, { readonly kind: "busy" }>;
  readonly sessionId: string;
  readonly source: { readonly runId: string; readonly hookTokens: readonly string[] };
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
  const refuse = (detail: string): SessionCheckpointValidation => {
    if (migration.kind === "pre-v27") return unreadable(detail);
    throw new Error(detail);
  };
  const checkpoint =
    migration.kind === "pre-v27" ? migration.imported.checkpoint : migration.checkpoint;
  const timeout = checkpoint.sessionTimeoutMs;
  if (
    timeout !== false &&
    (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0)
  )
    return refuse("Session checkpoint contains an invalid timeout duration.");
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
  if (
    sandboxState !== null &&
    sandboxState !== undefined &&
    !isRetiredSandboxSessionState(sandboxState)
  ) {
    const definition = owningSandboxDefinition(
      getResolvedRuntimeAgentNode(bundle.graph, bundle.nodeId).sandboxRegistry.sandbox,
    );
    if (definition.kind !== "independent") {
      return refuse("Session checkpoint sandbox has no resolved provider.");
    }
    const provider = getSandboxEnvironmentRuntime(definition.environment);
    const resolved = resolvePersistedSandboxSessionState(sandboxState, provider);
    if (
      resolved?.providerName !== provider.providerName ||
      resolved.stateProtocolVersion !== provider.stateProtocolVersion
    ) {
      return refuse("Session checkpoint sandbox provider state is incompatible.");
    }
  }
  if (!isSessionStateIdleForHandoff(checkpoint)) {
    return refuse("Session checkpoint contains pending work and cannot be handed off.");
  }
  if (!(await holdsEveryAddress(input.source))) return { kind: "source-gone" };
  await recordSessionOwner(input.sessionId);
  if (migration.kind === "pre-v27")
    log.info("session handoff accepted from an owner before v27", { sessionId: input.sessionId });
  return { kind: "valid" };
}

async function holdsEveryAddress(source: {
  readonly runId: string;
  readonly hookTokens: readonly string[];
}): Promise<boolean> {
  const holders = await mapWithConcurrency(source.hookTokens, 16, (token) =>
    findSessionHookHolder(sessionInboxHookToken(token)),
  );
  return holders.every((holder) => holder?.runId === source.runId);
}

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
    if (!HookNotFoundError.is(error)) throw error;
  }
}

export async function reportSessionTakenOverOutsideAttemptStep(input: {
  readonly sessionId: string;
}): Promise<void> {
  "use step";
  log.error("session taken over with no handoff attempt open; this run leaves without finalizing", {
    sessionId: input.sessionId,
  });
}

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

export async function sendSessionHandoverPartStep(input: {
  readonly bufferedPayloadCount: number;
  readonly part: Omit<SessionHandoverPayload, "kind">;
  readonly sessionId: string;
}): Promise<"delivered" | "session-ended"> {
  "use step";
  const attributes = {
    "eve.handoff.buffered_payload_count": input.bufferedPayloadCount,
    "eve.handoff.part_index": input.part.index,
  };
  if (input.part.index === 0) {
    traceSessionHandover("forwarding_started", input.sessionId, input.part.attemptKey, attributes);
  }
  try {
    const hook = await resumeHook(sessionInboxHookToken(sessionCommandHookToken(input.sessionId)), {
      ...input.part,
      kind: "handover",
    } satisfies SessionHandoverPayload);
    traceSessionHandover(
      input.part.final === true ? "final_submitted" : "part_submitted",
      input.sessionId,
      input.part.attemptKey,
      { ...attributes, "eve.handoff.destination_run_id": hook.runId },
    );
    return "delivered";
  } catch (error) {
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

export async function readSessionStreamTailStep(input: {
  readonly sessionId: string;
}): Promise<number> {
  "use step";
  return await readSessionStreamTailIndex(input.sessionId);
}
