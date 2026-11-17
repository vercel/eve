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

export interface SandboxState {
  readonly session: SandboxSessionState | null;
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

type SandboxSessionEndWithArtifact = (
  context: SandboxSessionContext,
  state: SandboxPreparedArtifact | null,
  options: {
    readonly artifact: SandboxPreparedArtifact | undefined;
    readonly reason: SandboxSessionEndReason;
  },
) => Promise<void>;

const sessionEndsWithArtifact = new WeakMap<object, SandboxSessionEndWithArtifact>();

export function withSessionEndArtifact<Implementation extends object>(
  implementation: Implementation,
  onSessionEnd: SandboxSessionEndWithArtifact,
): Implementation {
  sessionEndsWithArtifact.set(implementation, onSessionEnd);
  return implementation;
}

export function getSessionEndWithArtifact(
  implementation: object,
): SandboxSessionEndWithArtifact | undefined {
  return sessionEndsWithArtifact.get(implementation);
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
