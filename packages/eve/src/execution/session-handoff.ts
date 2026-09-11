import { createHook, type Hook } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, SessionCapabilities, TurnCaller } from "#channel/types.js";
import { readAcceptedDeploymentId } from "#execution/accepted-delivery-deployment.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";
import { isSessionIdleForHandoffStep } from "#execution/session-handoff-eligibility-step.js";
import {
  claimSessionHooks,
  type SessionInboxHandle,
  type SessionInboxPayload,
} from "#execution/session-inbox.js";
import { startSessionOwnerStep, type SessionOwnerStartInput } from "#execution/workflow-runtime.js";
import type { AgentWorkflowRetentionDefinition } from "#shared/agent-definition.js";
import type { RunMode } from "#shared/run-mode.js";

export interface SessionOwnership {
  /** Original Workflow run that owns the public output stream. */
  readonly anchorRunId: string;
  readonly sessionId: string;
  readonly ownerRunId: string;
  readonly deploymentId: string;
}

/** Complete hook set a successor must claim before it can own the session. */
export interface SessionHookClaims {
  /** The stable session inbox followed by every additive continuation address. */
  readonly session: readonly string[];
}

export interface SessionCheckpoint {
  readonly anchorToken: string;
  readonly caller?: TurnCaller;
  readonly capabilities?: SessionCapabilities;
  readonly hooks: SessionHookClaims;
  readonly mode: RunMode;
  readonly ownership: SessionOwnership;
  readonly retention?: AgentWorkflowRetentionDefinition;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly sessionTimeoutDeadline?: Date;
}

export type SessionHandoffCheckpoint =
  | {
      readonly kind: "ready";
      readonly checkpoint: SessionCheckpoint;
      readonly delivery: DeliverHookPayload;
      readonly targetDeploymentId: string;
    }
  | {
      readonly kind: "skipped";
      readonly reason: "same-deployment" | "missing-deployment" | "not-idle" | "busy";
    };

export type SessionOwnerActivation =
  | { readonly kind: "active" }
  | {
      readonly kind: "failed";
      readonly error: unknown;
      /** Commands accepted by partial successor claims before startup failed. */
      readonly payloads: readonly SessionInboxPayload[];
    };

export interface SessionHandoffCandidate {
  readonly activation: Hook<SessionOwnerActivation>;
  readonly runId: string;
}

/** The sole boundary for moving an idle session to another exact deployment. */
export class SessionHandoff {
  private readonly bufferedDeliveries: readonly DeliverHookPayload[];
  private readonly bufferedSessionControls: readonly unknown[];
  private readonly commandInbox: SessionInboxHandle;
  private readonly checkpointState: Omit<SessionCheckpoint, "ownership">;
  private readonly ownership: SessionOwnership;

  constructor(input: {
    readonly anchorToken: string;
    readonly bufferedDeliveries: readonly DeliverHookPayload[];
    readonly bufferedSessionControls: readonly unknown[];
    readonly caller?: TurnCaller;
    readonly capabilities?: SessionCapabilities;
    readonly commandInbox: SessionInboxHandle;
    readonly mode: RunMode;
    readonly ownership: SessionOwnership;
    readonly retention?: AgentWorkflowRetentionDefinition;
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
    readonly sessionTimeoutDeadline?: Date;
  }) {
    this.bufferedDeliveries = input.bufferedDeliveries;
    this.bufferedSessionControls = input.bufferedSessionControls;
    this.commandInbox = input.commandInbox;
    this.ownership = input.ownership;
    this.checkpointState = {
      anchorToken: input.anchorToken,
      caller: input.caller,
      capabilities: input.capabilities,
      hooks: {
        session: [...input.commandInbox.sessionHookTokens],
      },
      mode: input.mode,
      retention: input.retention,
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
      sessionTimeoutDeadline: input.sessionTimeoutDeadline,
    };
  }

  async checkpoint(delivery: DeliverHookPayload): Promise<SessionHandoffCheckpoint> {
    const targetDeploymentId = readAcceptedDeploymentId(delivery);
    if (targetDeploymentId === undefined) return { kind: "skipped", reason: "missing-deployment" };
    if (targetDeploymentId === this.ownership.deploymentId) {
      return { kind: "skipped", reason: "same-deployment" };
    }
    if (
      this.checkpointState.mode !== "conversation" ||
      this.bufferedDeliveries.length > 0 ||
      this.bufferedSessionControls.length > 0 ||
      (await this.commandInbox.hasPending())
    ) {
      return { kind: "skipped", reason: "busy" };
    }
    if (!(await isSessionIdleForHandoffStep({ sessionState: this.checkpointState.sessionState }))) {
      return { kind: "skipped", reason: "not-idle" };
    }
    return {
      checkpoint: {
        ...this.checkpointState,
        ownership: this.ownership,
      },
      delivery,
      kind: "ready",
      targetDeploymentId,
    };
  }

  async release(): Promise<readonly SessionInboxPayload[]> {
    return await this.commandInbox.release();
  }

  async start(
    ready: Extract<SessionHandoffCheckpoint, { readonly kind: "ready" }>,
  ): Promise<SessionHandoffCandidate> {
    const activation = createHook<SessionOwnerActivation>({
      token: `${this.ownership.ownerRunId}:handoff`,
    });
    await claimHookOwnership(activation);
    try {
      const input: SessionOwnerStartInput = {
        activationToken: activation.token,
        checkpoint: ready.checkpoint,
        delivery: ready.delivery,
        targetDeploymentId: ready.targetDeploymentId,
      };
      const started = await startSessionOwnerStep(input);
      return { activation, runId: started.runId };
    } catch (error) {
      await disposeHook(activation);
      throw error;
    }
  }

  async activate(candidate: SessionHandoffCandidate): Promise<SessionOwnerActivation> {
    try {
      return await candidate.activation;
    } finally {
      await disposeHook(candidate.activation);
    }
  }

  async recover(payloads: readonly SessionInboxPayload[]): Promise<void> {
    await claimSessionHooks(this.commandInbox, this.checkpointState.hooks.session);
    this.commandInbox.restore(payloads);
  }
}
