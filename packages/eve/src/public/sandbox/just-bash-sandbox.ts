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
 * The `python` and `javascript` flags enable just-bash's bundled
 * interpreters (`python3`, the `js-exec` QuickJS runtime). These forward
 * through `Sandbox.create` into the underlying `Bash` as of just-bash 3.1.0
 * (vercel-labs/just-bash#284); eve's peer floor is `just-bash@^3.1.0`
 * because older releases silently drop them, so `python: true` would no-op
 * rather than error.
 *
 * The remaining just-bash capability flags — a restricted `commands`
 * allow-list, `customCommands`, and a custom `fetch` — are not exposed
 * here: their just-bash types cannot be honestly restated as primitives,
 * and importing them would leak just-bash's types onto eve's public API
 * (which is why even `defenseInDepth` is narrowed to a plain boolean). See
 * issue #431.
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
   * Enable just-bash's bundled `python3`/`python` commands (stdlib-only
   * CPython compiled to WebAssembly — no `pip`). Disabled by default;
   * Python adds security surface (arbitrary code execution via CPython).
   * Maps to just-bash `SandboxOptions.python`. Requires `just-bash@^3.1.0`
   * — on older releases it silently no-ops.
   */
  readonly python?: boolean;
  /**
   * Enable just-bash's bundled `js-exec` command (sandboxed JavaScript via
   * QuickJS). Disabled by default. Maps to just-bash
   * `SandboxOptions.javascript`; eve exposes only the boolean form (pass
   * `true` to enable), not just-bash's richer `JavaScriptConfig` object.
   * Requires `just-bash@^3.1.0` — on older releases it silently no-ops.
   */
  readonly javascript?: boolean;
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
