import type { SandboxSession } from "#public/definitions/sandbox.js";
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

export interface SandboxAccess {
  readonly environment?: SandboxEnvironmentIdentity;
  captureState(): Promise<SandboxState>;
  delete?(options?: SandboxDeleteOptions): Promise<void>;
  get(): Promise<SandboxSession | null>;
  stop(): Promise<void>;
}
