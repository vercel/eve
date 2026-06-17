import type { SandboxSession } from "#shared/sandbox-session.js";
import type { SandboxBackend } from "#shared/sandbox-backend.js";
import type { SessionContext } from "#public/definitions/callback-context.js";

/**
 * Opens the template session inside a `bootstrap` hook. Optional `options`
 * (typed by the backend's bootstrap-use options `BO`) are applied to the
 * template before the snapshot is captured. Resolves to the
 * {@link SandboxSession} to operate on.
 */
export type SandboxBootstrapUseFn<O = Record<string, never>> = (
  options?: O,
) => Promise<SandboxSession>;

/**
 * Opens the live sandbox session inside an `onSession` hook. Optional
 * `options` (typed by the backend's session-use options `SO`) are applied
 * to the live session. Resolves to the {@link SandboxSession} for the
 * current turn.
 */
export type SandboxSessionUseFn<O = Record<string, never>> = (
  options?: O,
) => Promise<SandboxSession>;

/**
 * Argument passed to a sandbox `bootstrap` hook. `use(options?)` opens the
 * template session that the snapshot is captured from; backend-specific
 * `options` (typed by the backend's bootstrap-use options `BO`) are applied
 * to that template.
 */
export interface SandboxBootstrapContext<O = Record<string, never>> {
  readonly use: SandboxBootstrapUseFn<O>;
}

/**
 * Argument passed to a sandbox `onSession` hook, invoked once per live
 * session. `ctx` is the runtime {@link SessionContext} (session id, auth,
 * turn). `use(options?)` opens the live session, applying backend-specific
 * `options` (typed by the backend's session-use options `SO`).
 */
export interface SandboxSessionContext<O = Record<string, never>> {
  readonly ctx: SessionContext;
  readonly use: SandboxSessionUseFn<O>;
}

/**
 * Resolves a build-time revalidation key for a bootstrap snapshot. eve
 * evaluates it during compile/build and freezes the result into compiled
 * artifacts. Supply one only for external inputs that affect bootstrap
 * output; authored source and managed seeds are tracked automatically.
 */
export type SandboxRevalidationKeyFn = () => Promise<string> | string;

/**
 * Public sandbox definition authored in `agent/sandbox.ts` (shorthand)
 * or `agent/sandbox/sandbox.ts` (folder layout, when paired with an
 * authored `sandbox/workspace/` subtree).
 *
 * Each agent (and each subagent) owns exactly one sandbox. When the
 * module file is absent the framework auto-provides a default sandbox
 * via `defaultSandbox()`. Authors override lifecycle and backend by
 * creating `agent/sandbox.ts` (or `agent/sandbox/sandbox.ts` when they
 * also want a workspace folder); subagents override independently via
 * `subagents/<name>/sandbox.ts` (or the folder form) and do not inherit
 * their parent's sandbox (skill seeds differ per agent).
 */
interface SandboxDefinitionBase<BO = Record<string, never>, SO = Record<string, never>> {
  /**
   * Backend that runs this sandbox.
   *
   * Accepts either a {@link SandboxBackend} value or a zero-arg factory
   * function that returns one. The factory form is invoked lazily on
   * first framework access and the result is memoized for the lifetime
   * of the process, so backend-internal state (such as the Vercel
   * backend's prewarmed-template cache) is preserved across every call.
   * Use the factory form to defer evaluation, for example when create
   * options depend on environment variables that aren't set at module
   * load time:
   *
   * ```ts
   * defineSandbox({
   *   backend: () => vercel({ env: { TOKEN: process.env.TOKEN ?? "" } }),
   * });
   * ```
   *
   * When this field is omitted, eve substitutes `defaultSandbox()` at
   * runtime, which picks the best available backend: `vercel()`
   * on hosted Vercel (where `process.env.VERCEL` is set), then Docker,
   * microsandbox, or just-bash
   * everywhere else. Set `backend` explicitly to pin the sandbox to a
   * specific backend regardless of environment.
   */
  readonly backend: SandboxBackend<BO, SO> | (() => SandboxBackend<BO, SO>);
  /** Human-readable description of this sandbox, surfaced in tooling. */
  readonly description?: string;
  /**
   * Runs once per live session before authored steps use the sandbox.
   * Call `input.use(options?)` to open the session and apply per-session
   * backend options (typed by `SO`).
   */
  onSession?(input: SandboxSessionContext<SO>): Promise<void> | void;
}

export interface SandboxDefinitionWithBootstrap<
  BO = Record<string, never>,
  SO = Record<string, never>,
> extends SandboxDefinitionBase<BO, SO> {
  bootstrap(input: SandboxBootstrapContext<BO>): Promise<void> | void;
  /**
   * Optional build-time revalidation key for the reusable sandbox
   * snapshot produced by {@link bootstrap}. eve evaluates this
   * function during compile/build, stores the resolved string in
   * compiled artifacts, and uses that frozen value for both prewarm and
   * runtime session create. Authored sandbox source and
   * framework-managed seed contents are included automatically; provide
   * this key only for external inputs that affect bootstrap output.
   */
  readonly revalidationKey?: SandboxRevalidationKeyFn;
}

export interface SandboxDefinitionWithoutBootstrap<
  BO = Record<string, never>,
  SO = Record<string, never>,
> extends SandboxDefinitionBase<BO, SO> {
  bootstrap?: undefined;
  readonly revalidationKey?: never;
}

export type SandboxDefinition<BO = Record<string, never>, SO = Record<string, never>> =
  | SandboxDefinitionWithBootstrap<BO, SO>
  | SandboxDefinitionWithoutBootstrap<BO, SO>;
