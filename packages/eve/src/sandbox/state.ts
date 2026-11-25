import type { SandboxSession } from "#public/definitions/sandbox.js";
import type { SandboxProviderRuntime } from "#sandbox/provider.js";
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
  readonly idleTimeoutMs: number;
}

export interface SandboxState {
  readonly session: SandboxSessionState | null;
  readonly running?: SandboxRunning;
  readonly sourceCopied?: true;
}

export function clearSandboxRunning(state: SandboxState | undefined): SandboxState | undefined {
  if (state?.running === undefined) return state;
  const { running: _running, ...rest } = state;
  return rest;
}

export function markSandboxRunning<Session extends { readonly sandboxState?: SandboxState }>(
  session: Session,
  idleTimeoutMs: number | undefined,
): Session {
  if (idleTimeoutMs === undefined) return session;
  return {
    ...session,
    sandboxState: {
      ...session.sandboxState,
      session: session.sandboxState?.session ?? null,
      running: { idleTimeoutMs },
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

interface RecordedSandboxProvider {
  readonly implementation: SandboxProviderRuntime["implementation"];
  readonly state: SandboxPreparedArtifact | null;
}

type RecordedSandboxProviderLookup = (
  state: SandboxPreparedArtifact | null,
  artifact: SandboxPreparedArtifact | undefined,
) => RecordedSandboxProvider | undefined;

const recordedSandboxProviderLookups = new WeakMap<object, RecordedSandboxProviderLookup>();

export function withRecordedSandboxProvider<Implementation extends object>(
  implementation: Implementation,
  lookup: RecordedSandboxProviderLookup,
): Implementation {
  recordedSandboxProviderLookups.set(implementation, lookup);
  return implementation;
}

export async function resolveRecordedSandboxProvider(
  provider: Pick<SandboxProviderRuntime, "implementation">,
  state: SandboxPreparedArtifact | null,
  loadArtifact: () => Promise<SandboxPreparedArtifact | undefined>,
): Promise<RecordedSandboxProvider | undefined> {
  const lookup = recordedSandboxProviderLookups.get(provider.implementation);
  if (lookup === undefined) return { implementation: provider.implementation, state };
  return lookup(state, await loadArtifact());
}

export function recordedSandboxStopsIdle(
  provider: Pick<SandboxProviderRuntime, "implementation">,
  recorded: SandboxSessionState | null | undefined,
): boolean {
  if (recorded === null || recorded === undefined) return true;
  const lookup = recordedSandboxProviderLookups.get(provider.implementation);
  const resolved = lookup === undefined ? provider : lookup(recorded.state, undefined);
  return resolved === undefined || resolved.implementation.onSessionIdle !== undefined;
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
