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
 * Storage location for Eve-managed skill packages, bound to one agent
 * home. Mirrors `SkillStoreLocation` in `#runtime/skills/store.js`
 * without importing runtime-tier code into this leaf module.
 */
export interface SandboxSkillStoreLocation {
  readonly home?: string;
}

/**
 * Lazy sandbox accessor bound to one step execution.
 *
 * Returned by `ensureSandboxAccess` and placed on the `AlsContext` (via
 * `SandboxKey`) so tools can call `ctx.getSandbox()`.
 *
 * Node-bound facts (the skill store location) ride on the access itself so
 * harness-tier consumers never re-derive them from runtime-tier context.
 */
export interface SandboxAccess {
  captureState(): Promise<SandboxState>;
  get(): Promise<SandboxSession | null>;
  readonly skillStoreLocation?: SandboxSkillStoreLocation;
  stop(): Promise<void>;
}
