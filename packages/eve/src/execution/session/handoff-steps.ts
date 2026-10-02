import { queuedInput } from "#harness/session-machine/view.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { openInputs, openSignIns } from "#protocol/session-projection.js";
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

/**
 * A session hands off only between turns with nothing open: no request, sign-in, or queued
 * input. Open work is whatever the stored projection shows open, so a new kind of work is
 * covered as soon as the stream reports it.
 */
export function isSessionStateIdleForHandoff(input: {
  readonly sessionState: DurableSessionState;
}): boolean {
  const projection = storedProjection(readDurableSession(input.sessionState).state);
  return (
    projection.activeTurnId === undefined &&
    openInputs(projection).length === 0 &&
    openSignIns(projection).length === 0 &&
    queuedInput(readDurableSession(input.sessionState).state) === undefined
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
 * Validates a checkpoint and resolves the target deployment's compiled bundle.
 *
 * A version mismatch is a settled answer about this deployment, not a fault, so
 * it returns rather than throws: retrying the step can never change it.
 */
export async function validateSessionCheckpointStep(input: {
  readonly checkpoint: SessionCheckpoint;
}): Promise<SessionCheckpointValidation> {
  "use step";
  const { checkpoint } = input;
  if (checkpoint.version !== SESSION_CHECKPOINT_VERSION) {
    return { kind: "incompatible", reason: "checkpoint-version" };
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
  if (!isSessionStateIdleForHandoff(checkpoint)) {
    throw new Error("Session checkpoint contains pending work and cannot be handed off.");
  }
  return { kind: "valid" };
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
