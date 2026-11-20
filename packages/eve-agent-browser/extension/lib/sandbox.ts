import {
  buildShellCommand,
  createAgentBrowserCommandResult,
  defaultSessionName,
  quoteShellArg,
  resolveAgentBrowserInstallSpec,
  throwIfCommandFailed,
  type AgentBrowserArgs,
  type AgentBrowserCommandResult,
  type AgentBrowserInstallOptions,
  type BuildShellCommandOptions,
} from "./shared.js";

export {
  AgentBrowserCommandError,
  DEFAULT_AGENT_BROWSER_INSTALL_SPEC,
  buildAgentBrowserArgv,
  quoteShellArg,
  resolveAgentBrowserInstallSpec,
  type AgentBrowserCommandResult,
  type AgentBrowserInstallOptions,
} from "./shared.js";

/** Output of one command run in an eve sandbox. Missing fields are treated as exit code `0` and empty output. */
export interface EveSandboxCommandResult {
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly stdout?: string;
}

/** The part of an eve sandbox session the agent-browser helpers need: running a shell command. */
export interface EveSandboxSession {
  run(options: {
    readonly signal?: AbortSignal;
    readonly command: string;
  }): PromiseLike<EveSandboxCommandResult>;
}

/** The part of an eve tool context {@link runAgentBrowser} needs to reach the session's sandbox. */
export interface EveToolContext {
  getSandbox(): PromiseLike<EveSandboxSession | null>;
}

/** Options for {@link installAgentBrowser}. */
export interface EveInstallAgentBrowserOptions extends AgentBrowserInstallOptions {
  /** Cancels the install commands when aborted. */
  readonly abortSignal?: AbortSignal;
  /** npm binary used to install agent-browser globally. Defaults to `npm`. */
  readonly npmBinary?: string;
}

/** Options for {@link runAgentBrowser} and {@link buildAgentBrowserCommand}. */
export interface EveRunAgentBrowserOptions extends Omit<BuildShellCommandOptions, "session"> {
  /** Cancels the command when aborted. */
  readonly abortSignal?: AbortSignal;
  /** agent-browser session name. Defaults to a name built from `sessionPrefix`. */
  readonly session?: string;
  /** Prefix for the default session name. Defaults to `eve`. */
  readonly sessionPrefix?: string;
}

const APT_CHROMIUM_DEPENDENCIES: readonly (readonly [base: string, t64Variant?: string])[] = [
  ["libxcb-shm0"],
  ["libx11-xcb1"],
  ["libx11-6"],
  ["libxcb1"],
  ["libxext6"],
  ["libxrandr2"],
  ["libxcomposite1"],
  ["libxcursor1"],
  ["libxdamage1"],
  ["libxfixes3"],
  ["libxi6"],
  ["libgtk-3-0", "libgtk-3-0t64"],
  ["libglib2.0-0", "libglib2.0-0t64"],
  ["libpangocairo-1.0-0", "libpangocairo-1.0-0t64"],
  ["libpango-1.0-0", "libpango-1.0-0t64"],
  ["libatk1.0-0", "libatk1.0-0t64"],
  ["libcairo-gobject2", "libcairo-gobject2t64"],
  ["libcairo2", "libcairo2t64"],
  ["libgdk-pixbuf-2.0-0", "libgdk-pixbuf-2.0-0t64"],
  ["libxrender1"],
  ["libasound2", "libasound2t64"],
  ["libfreetype6"],
  ["libfontconfig1"],
  ["libdbus-1-3", "libdbus-1-3t64"],
  ["libnss3"],
  ["libnss3-tools"],
  ["libnspr4"],
  ["libatk-bridge2.0-0", "libatk-bridge2.0-0t64"],
  ["libdrm2"],
  ["libxkbcommon0"],
  ["libatspi2.0-0", "libatspi2.0-0t64"],
  ["libcups2", "libcups2t64"],
  ["libxshmfence1"],
  ["libgbm1"],
  ["fonts-noto-color-emoji"],
  ["fonts-noto-cjk"],
  ["fonts-freefont-ttf"],
];

const DNF_CHROMIUM_DEPENDENCIES = [
  "glib2",
  "nss",
  "nss-tools",
  "nspr",
  "libxkbcommon",
  "atk",
  "at-spi2-atk",
  "at-spi2-core",
  "libXcomposite",
  "libXdamage",
  "libXrandr",
  "libXfixes",
  "libXcursor",
  "libXi",
  "libXtst",
  "libXScrnSaver",
  "libXext",
  "mesa-libgbm",
  "libdrm",
  "mesa-libGL",
  "mesa-libEGL",
  "cups-libs",
  "alsa-lib",
  "pango",
  "cairo",
  "gtk3",
  "dbus-libs",
] as const;

const EVE_BOOTSTRAP_REVISION = "4";

/**
 * Cache key for a sandbox template prepared with {@link installAgentBrowser}.
 * It changes when the install spec or install options change, so custom template caches know to rebuild.
 */
export function agentBrowserRevalidationKey(options: AgentBrowserInstallOptions = {}): string {
  return [
    "agent-browser",
    `bootstrap-${EVE_BOOTSTRAP_REVISION}`,
    resolveAgentBrowserInstallSpec(options),
    options.installBrowser === false ? "no-browser" : "browser",
    options.installSystemDependencies === false ? "no-system-deps" : "system-deps",
  ].join(":");
}

/**
 * Installs agent-browser into a sandbox: Chromium system libraries, the npm package, and the browser, each unless disabled.
 * Call it from a sandbox environment's `prepare` callback so new sessions start from a prepared template. Throws {@link AgentBrowserCommandError} when a step fails.
 */
export async function installAgentBrowser(
  sandbox: EveSandboxSession,
  options: EveInstallAgentBrowserOptions = {},
): Promise<AgentBrowserCommandResult[]> {
  const npmBinary = options.npmBinary ?? "npm";
  const installSpec = resolveAgentBrowserInstallSpec(options);
  const commands = [];

  if (options.installSystemDependencies !== false) {
    commands.push(buildLinuxSystemDependenciesCommand());
  }

  commands.push(`${quoteShellArg(npmBinary)} install -g ${quoteShellArg(installSpec)}`);

  if (options.installBrowser !== false) {
    commands.push(buildShellCommand(["install"], { binary: "agent-browser", json: false }));
  }

  const results: AgentBrowserCommandResult[] = [];
  for (const command of commands) {
    const result = await sandbox.run({ signal: options.abortSignal, command });
    results.push(
      throwIfCommandFailed(
        createAgentBrowserCommandResult({
          command,
          exitCode: result.exitCode,
          stderr: result.stderr,
          stdout: result.stdout,
        }),
      ),
    );
  }
  return results;
}

/**
 * Runs an agent-browser CLI command in the tool's sandbox and returns its output, with `--json` output parsed.
 * Use it from an authored eve tool. Throws when the agent has no sandbox, and {@link AgentBrowserCommandError} when the command exits non-zero.
 */
export async function runAgentBrowser<TJson = unknown>(
  ctx: EveToolContext,
  args: AgentBrowserArgs,
  options: EveRunAgentBrowserOptions = {},
): Promise<AgentBrowserCommandResult<TJson>> {
  const sandbox = await ctx.getSandbox();
  if (sandbox === null) {
    throw new Error("agent-browser requires an eve sandbox. Configure agent/sandbox.ts first.");
  }

  const session = options.session ?? defaultSessionName(options.sessionPrefix ?? "eve", "default");
  const command = buildAgentBrowserCommand(args, { ...options, session });
  const result = await sandbox.run({ signal: options.abortSignal, command });

  return throwIfCommandFailed(
    createAgentBrowserCommandResult<TJson>({
      command,
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
    }),
  );
}

/** Builds the shell command string {@link runAgentBrowser} would run for the given CLI arguments and options. */
export function buildAgentBrowserCommand(
  args: AgentBrowserArgs,
  options: EveRunAgentBrowserOptions = {},
): string {
  return buildShellCommand(args, options);
}

function buildLinuxSystemDependenciesCommand(): string {
  const aptPackages = APT_CHROMIUM_DEPENDENCIES.map(formatAptDependency).join(" ");
  const dnfPackages = DNF_CHROMIUM_DEPENDENCIES.map(quoteShellArg).join(" ");
  return [
    "if command -v apt-get >/dev/null 2>&1; then",
    `sudo apt-get update && sudo apt-get install -y --no-install-recommends ${aptPackages} && sudo ldconfig;`,
    "elif command -v dnf >/dev/null 2>&1; then",
    `sudo dnf clean all && sudo dnf install -y --skip-broken -- ${dnfPackages} && sudo ldconfig;`,
    "else echo 'No supported package manager found for browser system dependencies.' >&2; exit 1; fi",
  ].join(" ");
}

function formatAptDependency([base, t64Variant]: readonly [string, string?]): string {
  if (t64Variant === undefined) {
    return quoteShellArg(base);
  }
  return `$(if apt-cache show ${quoteShellArg(t64Variant)} >/dev/null 2>&1; then printf %s ${quoteShellArg(
    t64Variant,
  )}; else printf %s ${quoteShellArg(base)}; fi)`;
}
