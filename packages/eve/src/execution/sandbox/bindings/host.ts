import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import { Readable, Writable } from "node:stream";

import { resolveLocalProviderSessionRootPath } from "#execution/sandbox/bindings/local-provider-utils.js";
import { withConnectionFastPaths } from "#execution/sandbox/internal-shell.js";
import { createSandboxProviderIdentity } from "#execution/sandbox/provider-identity.js";
import { streamToBuffer } from "#execution/sandbox/stream-utils.js";
import type {
  HostSandboxEnvironmentOptions,
  HostSandboxRuntimeOptions,
} from "#public/sandbox/host-sandbox.js";
import type {
  SandboxCommandResult,
  SandboxProcess,
  SandboxRemovePathOptions,
  SandboxWriteFilesOptions,
} from "#public/sandbox/index.js";
import {
  SANDBOX_AGENT_ENV,
  SandboxSessionGoneError,
  type SandboxConnection,
  type SandboxJson,
  type SandboxProviderImplementation,
  type SandboxSessionContext,
} from "#public/sandbox/provider.js";
import { isErrnoCode, isObject } from "#shared/guards.js";
import { isPathInsideOrEqual } from "#shared/path-inside.js";
import {
  invalidPreparedSandboxArtifactError,
  invalidSandboxSessionStateError,
} from "#shared/sandbox-recorded-data-error.js";
import { HOST_SKILL_ROOT_ENV } from "#shared/skill-paths.js";

export const HOST_PROVIDER_NAME = "host";

const HOST_STATE_VERSION = 1;
const HOST_ARTIFACT_VERSION = 1;
const CAPTURE_WORKSPACE_ROOT = "/__eve_host_prepare_workspace__";
const CAPTURE_SKILLS_ROOT = "/__eve_host_prepare_skills__";
const PROCESS_KILL_GRACE_MS = 500;
const PROCESS_GROUP_POLL_MS = 20;
const LINGERING_REAPER_INTERVAL_MS = 1_000;
const MAX_FAST_OUTPUT_BYTES = 4 * 1024 * 1024;

const DEFAULT_STRIPPED_ENV_KEYS = new Set([
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "EVE_DEV",
  "EVE_EVAL_AUTH_TOKEN",
  "EVE_EVAL_OIDC_TOKEN",
  "EVE_INBOX_HANDLE_SECRET",
  "EVE_SELF_MODIFICATION_GITHUB_TOKEN",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "HOST",
  "NITRO_HOST",
  "NITRO_PORT",
  "OPENAI_API_KEY",
  "PORT",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
  "VERCEL_OIDC_TOKEN",
  "VERCEL_TOKEN",
  "WORKFLOW_LOCAL_BASE_URL",
]);

type HostSandboxPreparedSkillFile = {
  readonly contentBase64: string;
  readonly path: string;
};

type HostSandboxPreparedArtifact = {
  readonly skills?: readonly HostSandboxPreparedSkillFile[];
  readonly version: typeof HOST_ARTIFACT_VERSION;
};

type SerializedEnvOverrides = Readonly<Record<string, string | null>>;

type HostSandboxSessionState = {
  readonly cwd: string;
  readonly env?: SerializedEnvOverrides;
  readonly version: typeof HOST_STATE_VERSION;
};

interface ActiveProcessGroup {
  readonly pgid: number | undefined;
  kill(): Promise<void>;
  untrack(): void;
}

const activeProcessesBySession = new Map<string, Set<ActiveProcessGroup>>();
const lingeringProcessGroups = new Set<ActiveProcessGroup>();
let lingeringReaperTimer: ReturnType<typeof setInterval> | undefined;
let exitHookInstalled = false;

function scheduleLingeringReaper(entry: ActiveProcessGroup): void {
  lingeringProcessGroups.add(entry);
  if (lingeringReaperTimer !== undefined) return;
  lingeringReaperTimer = setInterval(() => {
    for (const candidate of lingeringProcessGroups) {
      if (candidate.pgid === undefined || !isProcessGroupAlive(candidate.pgid)) {
        candidate.untrack();
      }
    }
    if (lingeringProcessGroups.size === 0 && lingeringReaperTimer !== undefined) {
      clearInterval(lingeringReaperTimer);
      lingeringReaperTimer = undefined;
    }
  }, LINGERING_REAPER_INTERVAL_MS);
  lingeringReaperTimer.unref?.();
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const processes of activeProcessesBySession.values()) {
      for (const entry of processes) {
        if (entry.pgid !== undefined) {
          try {
            process.kill(-entry.pgid, "SIGKILL");
          } catch {}
        }
      }
    }
    activeProcessesBySession.clear();
    lingeringProcessGroups.clear();
  });
}

function assertPosixHost(): void {
  if (process.platform === "win32") {
    throw new Error(
      "HostSandbox requires a POSIX host (Linux or macOS). On Windows, run inside WSL2 or use DockerSandbox or JustBashSandbox.",
    );
  }
}

export function resolveHostEnvironment(input: {
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  readonly callEnv?: Readonly<Record<string, string>>;
  readonly environmentEnv?: Readonly<Record<string, string | undefined>>;
  readonly inheritEnv: boolean;
  readonly runtimeEnv?: Readonly<Record<string, string | null | undefined>>;
  readonly skillsDir: string;
}): Record<string, string> {
  const merged: Record<string, string> = {};
  if (input.inheritEnv) {
    for (const [key, value] of Object.entries(input.baseEnv)) {
      if (
        value !== undefined &&
        !DEFAULT_STRIPPED_ENV_KEYS.has(key) &&
        !key.startsWith("EVE_DEV_") &&
        !key.startsWith("EVE_DEVELOPMENT_")
      ) {
        merged[key] = value;
      }
    }
  }
  Object.assign(merged, SANDBOX_AGENT_ENV);
  merged[HOST_SKILL_ROOT_ENV] = input.skillsDir;
  applyEnvOverrides(merged, input.environmentEnv);
  applyEnvOverrides(merged, input.runtimeEnv);
  if (input.callEnv !== undefined) {
    Object.assign(merged, input.callEnv);
  }
  return merged;
}

export function createHostSandboxProvider(
  options: HostSandboxEnvironmentOptions = {},
): SandboxProviderImplementation<
  HostSandboxRuntimeOptions,
  HostSandboxPreparedArtifact,
  HostSandboxSessionState,
  {}
> {
  const inheritEnv = options.inheritEnv ?? true;
  const loginShell = options.loginShell ?? false;
  const configuredShell = options.shell;
  if (configuredShell !== undefined && configuredShell.trim().length === 0) {
    throw new Error("HostSandbox `shell` must be a non-empty executable path or command name.");
  }
  if (options.cwd !== undefined && options.cwd.trim().length === 0) {
    throw new Error("HostSandbox `cwd` must be a non-empty directory path.");
  }

  function resolveShell(): string {
    if (configuredShell !== undefined) return configuredShell;
    if (existsSync("/bin/bash")) return "/bin/bash";
    if (existsSync("/usr/bin/bash")) return "/usr/bin/bash";
    return "/bin/sh";
  }

  async function connect(
    context: SandboxSessionContext,
    artifactValue: SandboxJson,
    cwd: string,
    runtimeEnv: Readonly<Record<string, string | null | undefined>> | undefined,
    goneOnMissing: boolean,
  ): Promise<SandboxConnection> {
    assertPosixHost();
    const artifact = requirePreparedHostArtifact(artifactValue);
    await assertHostDirectoryExists(cwd, { goneOnMissing });
    const skillsDir = join(resolveHostSessionDir(context), "skills");
    await materializeHostSkills(skillsDir, artifact.skills);
    return createHostConnection({
      cwd,
      environmentEnv: options.env,
      inheritEnv,
      loginShell,
      runtimeEnv,
      sessionKey: sessionRegistryKey(context),
      shell: resolveShell(),
      skillsDir,
    });
  }

  return {
    async onSessionEnd(context, _state, { signal }) {
      signal?.throwIfAborted();
      await stopSessionProcesses(sessionRegistryKey(context));
      await rm(resolveHostSessionDir(context), { force: true, recursive: true });
    },

    async prepare(context) {
      assertPosixHost();
      if (context.isEmpty) {
        return { version: HOST_ARTIFACT_VERSION };
      }

      const skills: HostSandboxPreparedSkillFile[] = [];
      const unsupportedBuildMutation = () => {
        throw new Error(
          "HostSandbox does not run build-time `prepare` scripts because it connects directly to the runtime host rather than building a template image. " +
            "Install tools on the host or run per-session setup after `environment.open()` in `defineSandbox()`.",
        );
      };

      const captureConnection: SandboxConnection = withConnectionFastPaths(
        {
          workspaceRoot: CAPTURE_WORKSPACE_ROOT,
          readFile: async () => unsupportedBuildMutation(),
          removePath: async () => unsupportedBuildMutation(),
          spawn: async () => unsupportedBuildMutation(),
          stop: async () => {},
          async writeFiles({ files }) {
            for (const file of files) {
              const normalized = posix.normalize(file.path);
              if (
                normalized === CAPTURE_SKILLS_ROOT ||
                normalized.startsWith(`${CAPTURE_SKILLS_ROOT}/`)
              ) {
                const relativePath = normalized.slice(CAPTURE_SKILLS_ROOT.length + 1);
                assertSafeRelativeSkillPath(relativePath);
                skills.push({
                  contentBase64: Buffer.from(file.content).toString("base64"),
                  path: relativePath,
                });
                continue;
              }
              if (
                normalized === CAPTURE_WORKSPACE_ROOT ||
                normalized.startsWith(`${CAPTURE_WORKSPACE_ROOT}/`)
              ) {
                throw new Error(
                  "HostSandbox connects directly to an existing host directory and does not seed `agent/sandbox/workspace/` files into it. " +
                    "Remove `agent/sandbox/workspace/` or use DockerSandbox, VercelSandbox, or JustBashSandbox.",
                );
              }
              throw new Error(`HostSandbox preparation cannot write to "${file.path}".`);
            }
          },
        },
        { skillsRoot: CAPTURE_SKILLS_ROOT },
      );

      await context.populate(captureConnection);
      return skills.length > 0
        ? { skills, version: HOST_ARTIFACT_VERSION }
        : { version: HOST_ARTIFACT_VERSION };
    },

    async resume(context, artifactValue, stateValue) {
      const state = requireHostSessionState(stateValue);
      return await connect(context, artifactValue, state.cwd, state.env, true);
    },

    async start(context, openOptions, artifactValue) {
      const cwd = resolveStartWorkingDirectory(context, options.cwd, openOptions?.cwd);
      const connection = await connect(context, artifactValue, cwd, openOptions?.env, false);
      const serializedEnv = serializeEnvOverrides(openOptions?.env);
      const state: HostSandboxSessionState = {
        cwd,
        ...(serializedEnv !== undefined && { env: serializedEnv }),
        version: HOST_STATE_VERSION,
      };
      return { connection, state };
    },

    toolSessions: true,
  };
}

function createHostConnection(input: {
  readonly cwd: string;
  readonly environmentEnv?: Readonly<Record<string, string | undefined>>;
  readonly inheritEnv: boolean;
  readonly loginShell: boolean;
  readonly runtimeEnv?: Readonly<Record<string, string | null | undefined>>;
  readonly sessionKey: string;
  readonly shell: string;
  readonly skillsDir: string;
}): SandboxConnection {
  const { cwd, environmentEnv, inheritEnv, loginShell, runtimeEnv, sessionKey, shell, skillsDir } =
    input;
  const primaryArgs = loginShell ? ["-lc", "--"] : ["-c", "--"];
  const bashShell = basename(shell) === "bash";
  const fastArgs = bashShell ? ["--noprofile", "--norc", "-c", "--"] : ["-c", "--"];

  const commandEnv = (callEnv: Readonly<Record<string, string>>) =>
    resolveHostEnvironment({
      baseEnv: process.env,
      callEnv,
      environmentEnv,
      inheritEnv,
      runtimeEnv,
      skillsDir,
    });

  const spawnWithArgs = async (
    argsPrefix: readonly string[],
    options: {
      readonly command: string;
      readonly env: Readonly<Record<string, string>>;
      readonly signal?: AbortSignal;
      readonly stdin?: boolean;
      readonly workingDirectory: string;
    },
  ): Promise<SandboxProcess> => {
    options.signal?.throwIfAborted();
    const child = spawn(shell, [...argsPrefix, options.command], {
      cwd: options.workingDirectory,
      detached: true,
      env: commandEnv(options.env) as NodeJS.ProcessEnv,
      stdio: [options.stdin === true ? "pipe" : "ignore", "pipe", "pipe"],
    });
    if (options.stdin === true && child.stdin !== null) {
      child.stdin.on("error", () => {});
    }

    const stdout = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
    const stderr = Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>;
    const tracked = trackHostChildProcess(sessionKey, child, stdout, stderr, options.signal);

    return {
      pid: child.pid,
      ...(options.stdin === true && child.stdin !== null
        ? { stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array> }
        : {}),
      stderr,
      stdout,
      kill: tracked.kill,
      wait: () => tracked.completed,
    };
  };

  const connection: SandboxConnection = {
    workspaceRoot: cwd,
    async readFile({ path, signal }) {
      signal?.throwIfAborted();
      try {
        return await readFile(path, { signal });
      } catch (error) {
        if (isErrnoCode(error, "ENOENT")) return null;
        throw error;
      }
    },
    async removePath(options: SandboxRemovePathOptions) {
      options.signal?.throwIfAborted();
      await rm(options.path, {
        force: options.force === true,
        recursive: options.recursive === true,
      });
    },
    spawn: (options) => spawnWithArgs(primaryArgs, options),
    stop: () => stopSessionProcesses(sessionKey),
    async writeFiles(options: SandboxWriteFilesOptions) {
      for (const file of options.files) {
        options.signal?.throwIfAborted();
        await mkdir(dirname(file.path), { recursive: true });
        await writeFile(file.path, file.content, { signal: options.signal });
      }
    },
  };

  return withConnectionFastPaths(connection, {
    ...(bashShell || loginShell
      ? {
          async runFast(cmdOptions): Promise<SandboxCommandResult> {
            const proc = await spawnWithArgs(fastArgs, cmdOptions);
            let overflowed = false;
            const onOverflow = () => {
              if (overflowed) return;
              overflowed = true;
              void Promise.resolve(proc.kill()).catch(() => {});
            };
            const [stdoutBytes, stderrBytes, { exitCode }] = await Promise.all([
              streamToBuffer(proc.stdout, { maxBytes: MAX_FAST_OUTPUT_BYTES, onOverflow }),
              streamToBuffer(proc.stderr, { maxBytes: MAX_FAST_OUTPUT_BYTES, onOverflow }),
              proc.wait(),
            ]);
            if (overflowed) {
              throw new Error(
                `Sandbox internal command output exceeded the ${MAX_FAST_OUTPUT_BYTES}-byte limit.`,
              );
            }
            return {
              exitCode,
              stderr: stderrBytes.toString("utf8"),
              stdout: stdoutBytes.toString("utf8"),
            };
          },
        }
      : {}),
    skillsRoot: skillsDir,
  });
}

function trackHostChildProcess(
  sessionKey: string,
  child: ChildProcess,
  stdout: ReadableStream<Uint8Array>,
  stderr: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): {
  readonly completed: Promise<{ exitCode: number }>;
  kill(): Promise<void>;
} {
  const pgid = child.pid;
  let childExited = false;
  let killing: Promise<void> | undefined;
  let resolveExited!: () => void;
  const exited = new Promise<void>((resolveDone) => {
    resolveExited = resolveDone;
  });

  const untrack = () => {
    signal?.removeEventListener("abort", onAbort);
    lingeringProcessGroups.delete(entry);
    if (lingeringProcessGroups.size === 0 && lingeringReaperTimer !== undefined) {
      clearInterval(lingeringReaperTimer);
      lingeringReaperTimer = undefined;
    }
    const active = activeProcessesBySession.get(sessionKey);
    if (active !== undefined) {
      active.delete(entry);
      if (active.size === 0) activeProcessesBySession.delete(sessionKey);
    }
  };

  const destroyUnreadStdio = () => {
    if (!stdout.locked) child.stdout?.destroy();
    if (!stderr.locked) child.stderr?.destroy();
  };

  const kill = (): Promise<void> => {
    if (pgid === undefined) {
      untrack();
      return Promise.resolve();
    }
    if (childExited && !isProcessGroupAlive(pgid)) {
      destroyUnreadStdio();
      untrack();
      return Promise.resolve();
    }
    killing ??= (async () => {
      try {
        child.stdin?.destroy();
        sendGroupSignal(pgid, "SIGTERM");
        await waitForProcessGroupDeath(pgid, exited, PROCESS_KILL_GRACE_MS);
        if (!childExited || isProcessGroupAlive(pgid)) {
          sendGroupSignal(pgid, "SIGKILL");
          await waitForProcessGroupDeath(pgid, exited, PROCESS_KILL_GRACE_MS);
        }
        destroyUnreadStdio();
      } finally {
        untrack();
      }
    })();
    return killing;
  };

  const entry: ActiveProcessGroup = { kill, pgid, untrack };
  installExitHook();
  let sessionProcesses = activeProcessesBySession.get(sessionKey);
  if (sessionProcesses === undefined) {
    sessionProcesses = new Set();
    activeProcessesBySession.set(sessionKey, sessionProcesses);
  }
  sessionProcesses.add(entry);

  const onAbort = () => {
    void kill().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const completed = new Promise<{ exitCode: number }>((resolveDone, rejectDone) => {
    child.once("error", (error) => {
      rejectDone(error);
    });
    child.once("exit", (code, signalName) => {
      if (signal?.aborted) {
        rejectDone(signal.reason);
        return;
      }
      resolveDone({ exitCode: code ?? signalExitCode(signalName) });
    });
  }).finally(() => {
    childExited = true;
    resolveExited();
    if (pgid === undefined || !isProcessGroupAlive(pgid)) {
      untrack();
    } else {
      scheduleLingeringReaper(entry);
    }
  });
  completed.catch(() => {});

  return { completed, kill };
}

async function waitForProcessGroupDeath(
  pgid: number,
  exited: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await Promise.race([exited, delayUnref(timeoutMs)]);
  while (isProcessGroupAlive(pgid) && Date.now() < deadline) {
    await delayUnref(Math.min(PROCESS_GROUP_POLL_MS, Math.max(1, deadline - Date.now())));
  }
}

function delayUnref(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    timer.unref?.();
  });
}

function isProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return !isErrnoCode(error, "ESRCH");
  }
}

async function stopSessionProcesses(sessionKey: string): Promise<void> {
  const active = activeProcessesBySession.get(sessionKey);
  if (active === undefined) return;
  const entries = [...active];
  await Promise.allSettled(entries.map((entry) => entry.kill()));
}

function sendGroupSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isErrnoCode(error, "ESRCH")) {
      try {
        process.kill(pid, signal);
      } catch (fallbackError) {
        if (!isErrnoCode(fallbackError, "ESRCH")) throw fallbackError;
      }
    }
  }
}

function signalExitCode(signalName: NodeJS.Signals | null): number {
  if (signalName === null) return 137;
  const number = osConstants.signals[signalName];
  return typeof number === "number" ? 128 + number : 137;
}

function resolveStartWorkingDirectory(
  context: SandboxSessionContext,
  environmentCwd: string | undefined,
  runtimeCwd: string | undefined,
): string {
  const configured = runtimeCwd ?? environmentCwd;
  if (configured !== undefined) {
    if (configured.trim().length === 0) {
      throw new Error("HostSandbox `cwd` must be a non-empty directory path.");
    }
    return isAbsolute(configured) ? resolve(configured) : context.resolveProjectPath(configured);
  }
  return resolve(process.cwd());
}

async function assertHostDirectoryExists(
  cwd: string,
  options: { readonly goneOnMissing: boolean },
): Promise<void> {
  let info;
  try {
    info = await stat(cwd);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      if (options.goneOnMissing) {
        throw new SandboxSessionGoneError(`HostSandbox directory "${cwd}" no longer exists.`);
      }
      throw new Error(
        `HostSandbox working directory "${cwd}" does not exist. Create it before opening the sandbox or pass an existing directory.`,
      );
    }
    throw error;
  }
  if (!info.isDirectory()) {
    if (options.goneOnMissing) {
      throw new SandboxSessionGoneError(`HostSandbox path "${cwd}" is no longer a directory.`);
    }
    throw new Error(`HostSandbox working directory "${cwd}" is not a directory.`);
  }
}

function sessionRegistryKey(context: SandboxSessionContext): string {
  return `${context.storagePath}\0${context.session.id}`;
}

function resolveHostSessionDir(context: SandboxSessionContext): string {
  const hash = createSandboxProviderIdentity({
    sessionId: context.session.id,
    version: HOST_STATE_VERSION,
  }).slice(0, 24);
  return resolve(
    resolveLocalProviderSessionRootPath(context.storagePath, HOST_PROVIDER_NAME, hash),
  );
}

async function materializeHostSkills(
  skillsDir: string,
  skills: readonly HostSandboxPreparedSkillFile[] | undefined,
): Promise<void> {
  if (skills === undefined || skills.length === 0 || existsSync(skillsDir)) return;
  const tempDir = `${skillsDir}.${randomUUID()}.tmp`;
  let published = false;
  try {
    await mkdir(tempDir, { recursive: true });
    for (const file of skills) {
      assertSafeRelativeSkillPath(file.path);
      const target = resolve(tempDir, file.path);
      if (!isPathInsideOrEqual(target, tempDir)) {
        throw new Error(
          `HostSandbox prepared skill path escapes skills directory: "${file.path}".`,
        );
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(file.contentBase64, "base64"));
    }
    await mkdir(dirname(skillsDir), { recursive: true });
    try {
      await rename(tempDir, skillsDir);
      published = true;
    } catch (error) {
      if (!existsSync(skillsDir)) throw error;
    }
  } finally {
    if (!published) await rm(tempDir, { force: true, recursive: true }).catch(() => {});
  }
}

function assertSafeRelativeSkillPath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid HostSandbox skill file path: "${relativePath}".`);
  }
}

function applyEnvOverrides(
  target: Record<string, string>,
  overrides: Readonly<Record<string, string | null | undefined>> | undefined,
): void {
  if (overrides === undefined) return;
  for (const [key, value] of Object.entries(overrides)) {
    if (value == null) delete target[key];
    else target[key] = value;
  }
}

function serializeEnvOverrides(
  overrides: Readonly<Record<string, string | undefined>> | undefined,
): SerializedEnvOverrides | undefined {
  if (overrides === undefined) return undefined;
  const entries = Object.entries(overrides);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([key, value]) => [key, value ?? null]));
}

function requirePreparedHostArtifact(artifact: SandboxJson): HostSandboxPreparedArtifact {
  if (!isObject(artifact) || artifact.version !== HOST_ARTIFACT_VERSION) {
    throw invalidPreparedSandboxArtifactError("host sandbox");
  }
  if (artifact.skills === undefined) {
    return { version: HOST_ARTIFACT_VERSION };
  }
  if (
    !Array.isArray(artifact.skills) ||
    !artifact.skills.every(
      (entry) =>
        isObject(entry) &&
        typeof entry.path === "string" &&
        typeof entry.contentBase64 === "string",
    )
  ) {
    throw invalidPreparedSandboxArtifactError("host sandbox");
  }
  return {
    skills: artifact.skills as readonly HostSandboxPreparedSkillFile[],
    version: HOST_ARTIFACT_VERSION,
  };
}

function requireHostSessionState(state: SandboxJson): HostSandboxSessionState {
  if (
    !isObject(state) ||
    state.version !== HOST_STATE_VERSION ||
    typeof state.cwd !== "string" ||
    state.cwd.length === 0
  ) {
    throw invalidSandboxSessionStateError("host sandbox");
  }
  if (state.env !== undefined) {
    if (
      !isObject(state.env) ||
      !Object.values(state.env).every((value) => typeof value === "string" || value === null)
    ) {
      throw invalidSandboxSessionStateError("host sandbox");
    }
  }
  return {
    cwd: state.cwd,
    ...(state.env !== undefined && { env: state.env as SerializedEnvOverrides }),
    version: HOST_STATE_VERSION,
  };
}
