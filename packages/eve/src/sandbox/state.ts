import { randomUUID } from "node:crypto";

import type { SandboxSession } from "#public/definitions/sandbox.js";
import type { SandboxProviderRuntime, SandboxSessionContext } from "#sandbox/provider.js";
import type { SandboxEnvironmentIdentity } from "#shared/sandbox-environment.js";
import type { SandboxDeleteOptions, SandboxPreparedArtifact } from "#shared/sandbox-provider.js";

export type SandboxSessionEndReason = "completed" | "expired" | "failed";

export interface SandboxSessionState {
  readonly generation?: string;
  readonly providerName: string;
  readonly state: SandboxPreparedArtifact;
  readonly stateProtocolVersion: number;
}

export interface SandboxRunning {
  readonly generation: string;
  readonly idleTimeoutMs: number;
}

export interface SandboxState {
  readonly session: SandboxSessionState | null;
  readonly running?: SandboxRunning;
}

export function clearSandboxRunning(state: SandboxState | undefined): SandboxState | undefined {
  return state?.running === undefined ? state : { session: state.session };
}

export function markSandboxRunning<Session extends { readonly sandboxState?: SandboxState }>(
  session: Session,
  idleTimeoutMs: number | undefined,
): Session {
  if (idleTimeoutMs === undefined) return session;
  const generation = session.sandboxState?.running?.generation ?? randomUUID();
  return {
    ...session,
    sandboxState: {
      session: session.sandboxState?.session ?? null,
      running: { generation, idleTimeoutMs },
    },
  };
}

export function isRetiredSandboxSessionState(state: SandboxSessionState): boolean {
  return state.providerName === undefined || state.providerName === "microsandbox";
}

type SandboxSessionStateAdopter = (
  state: SandboxSessionState,
) => SandboxPreparedArtifact | undefined;

const adopters = new WeakMap<object, SandboxSessionStateAdopter>();

export function withAdoptedSandboxSessionStates<Implementation extends object>(
  implementation: Implementation,
  adopt: SandboxSessionStateAdopter,
): Implementation {
  adopters.set(implementation, adopt);
  return implementation;
}

export function resolvePersistedSandboxSessionState(
  state: SandboxSessionState | null | undefined,
  provider: SandboxProviderRuntime | undefined,
): SandboxSessionState | null {
  if (state === null || state === undefined || isRetiredSandboxSessionState(state)) return null;
  if (provider === undefined || state.providerName === provider.providerName) return state;
  const adopted = adopters.get(provider.implementation)?.(state);
  return adopted === undefined
    ? state
    : {
        ...state,
        providerName: provider.providerName,
        state: adopted,
        stateProtocolVersion: provider.stateProtocolVersion,
      };
}

interface SandboxSessionArtifactLifecycle {
  onSessionEnd(
    context: SandboxSessionContext,
    state: SandboxPreparedArtifact | null,
    options: {
      readonly artifact: SandboxPreparedArtifact | undefined;
      readonly reason: SandboxSessionEndReason;
    },
  ): Promise<void>;
  onSessionIdle(
    context: SandboxSessionContext,
    state: SandboxPreparedArtifact | null,
    options: { readonly artifact: SandboxPreparedArtifact | undefined },
  ): Promise<void>;
  stopsIdle(state: SandboxPreparedArtifact): boolean;
}

const sessionArtifactLifecycles = new WeakMap<object, SandboxSessionArtifactLifecycle>();

export function withSessionArtifact<Implementation extends object>(
  implementation: Implementation,
  lifecycle: SandboxSessionArtifactLifecycle,
): Implementation {
  sessionArtifactLifecycles.set(implementation, lifecycle);
  return implementation;
}

export function getSessionArtifactLifecycle(
  implementation: object,
): SandboxSessionArtifactLifecycle | undefined {
  return sessionArtifactLifecycles.get(implementation);
}

export type SandboxPreparation = (open: () => Promise<SandboxSession>) => Promise<void>;

export interface SandboxAccess {
  readonly environment?: SandboxEnvironmentIdentity;
  captureState(): Promise<SandboxState>;
  delete?(options?: SandboxDeleteOptions): Promise<void>;
  get(): Promise<SandboxSession | null>;
  open(): Promise<SandboxSession | null>;
  prepare(work?: SandboxPreparation): void;
  stop(): Promise<void>;
}
