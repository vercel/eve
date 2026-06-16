import type { SandboxBootstrapContext, SandboxSessionUseFn } from "#shared/sandbox-definition.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

/**
 * Live sandbox handle returned by a {@link SandboxBackend}.
 *
 * Wraps the public {@link SandboxSession} with lifecycle methods so the
 * runtime orchestrator can persist reconnect metadata and release
 * resources.
 */
export interface SandboxBackendHandle<SO = Record<string, never>> {
  readonly session: SandboxSession;
  readonly useSessionFn: SandboxSessionUseFn<SO>;
  captureState(): Promise<SandboxBackendSessionState>;
  dispose(): Promise<void>;
}

/**
 * Serializable per-sandbox reconnect record stored on the harness session.
 *
 * `backendName` matches the {@link SandboxBackend.name} of the backend
 * that produced this state. The runtime reads it to decide whether a
 * previously persisted handle is still compatible with the current
 * backend.
 */
export interface SandboxBackendSessionState {
  readonly backendName: string;
  readonly metadata: Record<string, unknown>;
  readonly sessionKey: string;
}

/**
 * One file written into a sandbox template before template state capture.
 */
export interface SandboxSeedFile {
  readonly path: string;
  readonly content: string | Buffer;
}

/**
 * Diagnostic tags attached to provider-owned sandbox resources.
 *
 * Built-in backends may forward these into their hosting platform's
 * native tagging system. eve supplies stable tags such as the active
 * agent, channel, and session id so sandboxes can be found and
 * attributed in provider dashboards.
 */
export type SandboxBackendTags = Readonly<Record<string, string>>;

/**
 * Framework-owned runtime context handed to a backend on every
 * {@link SandboxBackend.create} call.
 *
 * Backends use this to derive any per-call state that depends on the
 * surrounding application. For example, the local backend computes its
 * cache directory from `appRoot`. Backends that don't need anything
 * here may ignore the field entirely.
 */
export interface SandboxBackendRuntimeContext {
  readonly appRoot: string;
}

/**
 * Input passed to {@link SandboxBackend.create} when the runtime needs a
 * live sandbox session.
 */
export interface SandboxBackendCreateInput {
  /**
   * Reusable template key to open this session from. `null` means eve
   * intentionally skipped template prewarm because the sandbox has no
   * `bootstrap()` and no seed files, so the backend should create a
   * fresh session from its default base runtime.
   */
  readonly templateKey: string | null;
  readonly sessionKey: string;
  readonly existingMetadata?: Record<string, unknown>;
  /**
   * Runtime tags the backend should attach to sandbox resources when
   * the underlying provider supports tags.
   */
  readonly tags?: SandboxBackendTags;
  readonly runtimeContext: SandboxBackendRuntimeContext;
}

/**
 * Input passed to {@link SandboxBackend.prewarm} when the build pipeline
 * is preparing reusable templates.
 *
 * Every authored sandbox in the compiled graph receives exactly one
 * `prewarm(...)` call before runtime opens its first session. The
 * backend captures reusable template state from the supplied
 * `bootstrap` hook and `seedFiles`, then `backend.create(...)` opens
 * durable sessions from that state.
 */
export interface SandboxBackendPrewarmInput<BO = Record<string, never>> {
  readonly templateKey: string;
  readonly bootstrap?: (input: SandboxBootstrapContext<BO>) => void | Promise<void>;
  /**
   * Optional progress logger for backend-specific prewarm phases.
   */
  readonly log?: (message: string) => void;
  readonly runtimeContext: SandboxBackendRuntimeContext;
  readonly seedFiles: ReadonlyArray<SandboxSeedFile>;
}

/**
 * Outcome of one {@link SandboxBackend.prewarm} call.
 *
 * The build pipeline uses this to report in the build logs whether a
 * template state was reused from a prior deploy or captured fresh, so
 * a cache hit is distinguishable from an expensive rebuild.
 */
export interface SandboxBackendPrewarmResult {
  /**
   * `true` when existing template state was reused without rebuilding it;
   * `false` when the backend captured fresh template state.
   */
  readonly reused: boolean;
}

/**
 * Pluggable sandbox backend.
 *
 * A `SandboxBackend` is a value an author attaches to a
 * {@link SandboxDefinition} to choose which underlying runtime hosts the
 * sandbox. eve ships built-in backends (`docker()`,
 * `justbash()`, `microsandbox()`,
 * `vercel()`, and the availability-aware
 * `defaultSandbox()`), but the interface is public so authors can write
 * their own.
 *
 * A backend implements the full two-phase lifecycle:
 * {@link SandboxBackend.prewarm} captures reusable template state at
 * build time, and {@link SandboxBackend.create} starts or reattaches a
 * live session from that template at runtime.
 */
export interface SandboxBackend<BO = Record<string, never>, SO = Record<string, never>> {
  /**
   * Stable identifier for this backend implementation.
   *
   * Participates in cache-key derivation and the persisted reconnect
   * state, so two backends that should not share template state
   * must use distinct names. Built-in backends use `"vercel"` and
   * `"local"`. Custom backends pick a unique string.
   */
  readonly name: string;
  /**
   * Creates or reattaches one live sandbox session from a template
   * previously captured by {@link SandboxBackend.prewarm}. Throws
   * {@link SandboxTemplateNotProvisionedError} when the requested
   * template is missing.
   */
  create(input: SandboxBackendCreateInput): Promise<SandboxBackendHandle<SO>>;
  /**
   * Build-time prewarm hook. eve invokes this for every authored
   * sandbox in the compiled graph before serving traffic so the backend
   * can capture reusable template state. Idempotent against existing state
   * keyed by `templateKey`.
   *
   * Returns whether the state was reused from a prior run or captured
   * fresh so the build pipeline can surface that in its logs.
   */
  prewarm(input: SandboxBackendPrewarmInput<BO>): Promise<SandboxBackendPrewarmResult>;
}
