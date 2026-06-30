/**
 * Options accepted by `justbash(opts)`.
 *
 * The just-bash backend runs the workspace under the pure-JS `just-bash`
 * interpreter with a virtual filesystem — no daemon or VM required, but
 * no real binaries either. The `just-bash` package is not bundled with
 * eve; it is loaded lazily from the application install.
 *
 * Beyond `autoInstall`, the remaining fields forward through to
 * just-bash's `Sandbox.create(SandboxOptions)` call. They mirror the
 * `SandboxOptions` surface that just-bash actually accepts at sandbox
 * creation — execution limits, an overall timeout, and the
 * defense-in-depth toggle. Each defaults to just-bash's own default
 * (i.e. unchanged behavior) when omitted, so existing applications are
 * unaffected.
 *
 * Note: just-bash's bundled interpreters (`python3`, the `js-exec`
 * QuickJS runtime) are NOT reachable through this surface. Those flags
 * live on just-bash's `BashOptions` (the `new Bash(...)` constructor),
 * and `Sandbox.create` — the call eve uses — does not forward them into
 * the `Bash` it builds. Enabling them requires an upstream just-bash
 * change (forward the capability flags through `SandboxOptions`) or a
 * different construction path in eve; see issue #431.
 */
export interface JustBashSandboxCreateOptions {
  /**
   * When the `just-bash` package is missing from the application,
   * install it automatically with the project's package manager. Only
   * runs during `eve dev`; production processes always fail with an
   * actionable install error instead. Defaults to `true`.
   */
  readonly autoInstall?: boolean;
  /**
   * Overall wall-clock timeout for the sandbox, in milliseconds. Maps to
   * just-bash `SandboxOptions.timeoutMs`. Omit to use just-bash's
   * default (no eve-imposed timeout).
   */
  readonly timeoutMs?: number;
  /**
   * Maximum function/subshell call depth before the interpreter aborts.
   * Maps to just-bash `SandboxOptions.maxCallDepth`. Guards against
   * runaway recursion. Omit to use just-bash's default.
   */
  readonly maxCallDepth?: number;
  /**
   * Maximum number of commands a single script may execute before the
   * interpreter aborts. Maps to just-bash `SandboxOptions.maxCommandCount`.
   * Omit to use just-bash's default.
   */
  readonly maxCommandCount?: number;
  /**
   * Maximum loop iterations before the interpreter aborts. Maps to
   * just-bash `SandboxOptions.maxLoopIterations`. Omit to use just-bash's
   * default.
   */
  readonly maxLoopIterations?: number;
  /**
   * Defense-in-depth hardening: monkey-patches dangerous JavaScript
   * globals (`Function`, `eval`, `setTimeout`, `process`, …) while a
   * script runs, as a secondary escape-mitigation layer. Maps to
   * just-bash `SandboxOptions.defenseInDepth`. just-bash enables this by
   * default; pass `false` to opt out. Omit to use just-bash's default
   * (enabled).
   */
  readonly defenseInDepth?: boolean;
}
