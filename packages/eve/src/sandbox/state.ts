import type { SandboxSession } from "#public/definitions/sandbox.js";
import type { SandboxBackendSessionState } from "#public/definitions/sandbox-backend.js";

/**
 * Serializable sandbox reconnect record stored on the harness session.
 * Alias for {@link SandboxBackendSessionState} kept at this layer so
 * `SandboxState.session` can describe itself without importing the
 * backend's public-API spelling into harness code.
 */
export type SandboxSessionState = SandboxBackendSessionState;

/**
 * Serializable sandbox state carried on the harness session across
 * step boundaries.
 *
 * Contains only stable identifiers — live handles stay in a
 * process-level cache and are rehydrated per step via the backend.
 * Every agent owns exactly one sandbox, so the state is just a single
 * `initialized` flag and an optional persisted session record.
 */
export interface SandboxState {
  readonly initialized: boolean;
  readonly session: SandboxSessionState | null;
}

/**
 * Lazy sandbox accessor bound to one step execution.
 *
 * Returned by `ensureSandboxAccess` and placed on the `AlsContext` (via
 * `SandboxKey`) so tools can call `ctx.getSandbox()`.
 */
export interface SandboxAccess {
  captureState(): Promise<SandboxState>;
  dispose(): Promise<void>;
  get(): Promise<SandboxSession | null>;
}
