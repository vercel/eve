import type { SandboxSession } from "#public/definitions/sandbox.js";
import type { SandboxProviderRuntime, SandboxSessionContext } from "#sandbox/provider.js";
import type { SandboxEnvironmentIdentity } from "#shared/sandbox-environment.js";
import type { SandboxDeleteOptions, SandboxPreparedArtifact } from "#shared/sandbox-provider.js";

export type SandboxSessionEndReason = "completed" | "expired" | "failed";

export interface SandboxSessionState {
  /**
   * Set anew each time this session's access calls `start()`, which is an upsert,
   * and kept on resume. Providers name a session's sandbox deterministically, so
   * without it a sandbox recreated after it was gone would look like the old one
   * to dynamic skills, which then write their files into it at the next turn. A
   * sandbox that a sharing subagent or a borrowed workflow step starts keeps this
   * session's generation. Absent in state saved by earlier releases.
   */
  readonly generation?: string;
  readonly providerName: string;
  readonly state: SandboxPreparedArtifact;
  readonly stateProtocolVersion: number;
}

export interface SandboxState {
  readonly session: SandboxSessionState | null;
}

/**
 * Whether no provider can resume this persisted record, so callers treat it as
 * no sandbox: records saved before the provider redesign (eve 0.64) have no
 * `providerName`, and `microsandbox` was removed as a provider.
 */
export function isRetiredSandboxSessionState(state: SandboxSessionState): boolean {
  return state.providerName === undefined || state.providerName === "microsandbox";
}

/** Converts a record another provider wrote into this provider's state, or `undefined`. */
type SandboxSessionStateAdopter = (
  state: SandboxSessionState,
) => SandboxPreparedArtifact | undefined;

const adopters = new WeakMap<object, SandboxSessionStateAdopter>();

/**
 * Lets an eve-owned provider resume records that another provider name wrote,
 * such as `DefaultSandbox` for sessions saved when it recorded the provider it
 * picked. Internal, so the public provider API is unchanged.
 */
export function withAdoptedSandboxSessionStates<Implementation extends object>(
  implementation: Implementation,
  adopt: SandboxSessionStateAdopter,
): Implementation {
  adopters.set(implementation, adopt);
  return implementation;
}

/**
 * The persisted record the current provider should resume, or `null` for no
 * sandbox. A record the provider cannot adopt is returned as-is; resuming it
 * starts a fresh sandbox, and handoff rejects it. An adopted record keeps its
 * `generation`, because it still names the same live sandbox.
 */
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

/** Session-end cleanup that also needs the current build's prepared artifact. */
type SandboxSessionEndWithArtifact = (
  context: SandboxSessionContext,
  state: SandboxPreparedArtifact | null,
  options: {
    readonly artifact: SandboxPreparedArtifact | undefined;
    readonly reason: SandboxSessionEndReason;
  },
) => Promise<void>;

const sessionEndsWithArtifact = new WeakMap<object, SandboxSessionEndWithArtifact>();

/**
 * Lets an eve-owned provider receive the prepared artifact at session end,
 * such as `DefaultSandbox`, which finds the provider it selected there when
 * no state was recorded. Internal, so the public provider API is unchanged.
 */
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

export interface SandboxAccess {
  readonly environment?: SandboxEnvironmentIdentity;
  captureState(): Promise<SandboxState>;
  delete?(options?: SandboxDeleteOptions): Promise<void>;
  get(): Promise<SandboxSession | null>;
  stop(): Promise<void>;
}
