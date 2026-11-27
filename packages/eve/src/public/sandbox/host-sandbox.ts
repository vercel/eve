/** Options shared by every session created from one HostSandbox environment. */
export interface HostSandboxEnvironmentOptions {
  /**
   * Default working directory for sessions. Relative paths resolve from the
   * project root. When omitted, defaults to `process.cwd()` when the session
   * starts.
   */
  readonly cwd?: string;
  /**
   * Environment variables layered over the inherited host environment.
   * Setting a key to `undefined` unsets an inherited variable.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Inherit the host process environment, excluding eve, Nitro, and
   * model-provider server variables by default. Set `false` to start from a
   * minimal environment containing only `AI_AGENT=eve`, `EVE_SKILLS_DIR`, and
   * explicit `env`.
   * @default true
   */
  readonly inheritEnv?: boolean;
  /**
   * Start shells as login shells (`-lc`) instead of non-login shells (`-c`).
   * Defaults to `false` so inherited host or container `PATH` values are not
   * reset by `/etc/profile` and login startup output does not enter stdout.
   * @default false
   */
  readonly loginShell?: boolean;
  /**
   * Shell executable used for `run()` and `spawn()`. Defaults to `/bin/bash`
   * when present, then `/usr/bin/bash`, then `/bin/sh`.
   */
  readonly shell?: string;
}

/** Options applied when eve opens one live HostSandbox session. */
export interface HostSandboxRuntimeOptions {
  /**
   * Working directory for this session. Overrides the environment's `cwd` and
   * defaults to `process.cwd()` when neither is set.
   */
  readonly cwd?: string;
  /**
   * Per-session environment overrides layered over the environment's `env`.
   * Setting a key to `undefined` unsets a variable. Values passed here are
   * stored in durable session state so resumed steps keep them; pass ephemeral
   * credentials per command or in environment-level `env`.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}
