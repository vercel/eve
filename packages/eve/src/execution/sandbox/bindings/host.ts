import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import { Readable, Writable } from "node:stream";

import {
  type ConnectionCommandOptions,
  withConnectionFastPaths,
} from "#execution/sandbox/internal-shell.js";
import { createSandboxProviderIdentity } from "#execution/sandbox/provider-identity.js";
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
import { isObject } from "#shared/guards.js";
import { isPathInsideOrEqual } from "#shared/path-inside.js";
import {
  invalidPreparedSandboxArtifactError,
  invalidSandboxSessionStateError,
} from "#shared/sandbox-recorded-data-error.js";
import { HOST_SKILL_ROOT_ENV } from "#shared/skill-paths.js";

export const HOST_PROVIDER_NAME = "host";

const HOST_STATE_VERSION = 1;
const HOST_ARTIFACT_VERSION = 1;
const HOST_CACHE_DIRECTORY_NAME = "host";
const CAPTURE_WORKSPACE_ROOT = "/__eve_host_prepare_workspace__";
const CAPTURE_SKILLS_ROOT = "/__eve_host_prepare_skills__";
const PROCESS_KILL_GRACE_MS = 200;

const DEFAULT_STRIPPED_ENV_KEYS = new Set([
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "EVE_DEV",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "NITRO_HOST",
  "NITRO_PORT",
  "OPENAI_API_KEY",
  "VERCEL_OIDC_TOKEN",
]);

const DEFAULT_STRIPPED_ENV_PREFIXES = ["EVE_DEVELOPMENT_"] as const;

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

interface TrackedHostProcess {
  kill(): Promise<void>;
}

const activeProcessesBySession = new Map<string, Set<TrackedHostProcess>>();

export function assertPosixHost(platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    throw new Error(
      "HostSandbox requires a POSIX host (Linux or macOS). On Windows, run inside WSL2 or use DockerSandbox or JustBashSandbox.",
    );
  }
}

export function isDefaultStrippedHostEnv(name: string): boolean {
  if (DEFAULT_STRIPPED_ENV_KEYS.has(name)) return true;
  return DEFAULT_STRIPPED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function resolveHostEnvironment(input: {
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  readonly callEnv?: Readonly<Record<string, string>>;
  readonly environmentEnv?: Readonly<Record<string, string | undefined>>;
  readonly inheritEnv: boolean;
  readonly runtimeEnv?: Readonly<Record<string, string | undefined>>;
  readonly skillsDir: string;
}): Record<string, string> {
  const merged: Record<string, string> = {};
  if (input.inheritEnv) {
    for (const [key, value] of Object.entries(input.baseEnv)) {
      if (value !== undefined && !isDefaultStrippedHostEnv(key)) {
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

  return {
    async onSessionEnd(context, _state, { signal }) {
      throwIfAborted(signal);
      const sessionKey = sessionRegistryKey(context);
      await stopSessionProcesses(sessionKey);
      const { sessionDir, sessionsRoot } = resolveHostSessionPaths(context);
      if (isPathInsideOrEqual(sessionDir, sessionsRoot)) {
        await rm(sessionDir, { force: true, recursive: true });
      }
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
          async readFile() {
            return unsupportedBuildMutation();
          },
          async removePath() {
            return unsupportedBuildMutation();
          },
          async spawn() {
            return unsupportedBuildMutation();
          },
          async stop() {},
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
      assertPosixHost();
      const artifact = requirePreparedHostArtifact(artifactValue);
      const state = requireHostSessionState(stateValue);
      await assertHostDirectoryExists(state.cwd, { goneOnMissing: true });
      const { skillsDir } = resolveHostSessionPaths(context);
      await materializeHostSkills(skillsDir, artifact.skills);
      return createHostConnection({
        cwd: state.cwd,
        environmentEnv: options.env,
        inheritEnv,
        loginShell,
        runtimeEnv: deserializeEnvOverrides(state.env),
        sessionKey: sessionRegistryKey(context),
        shell: resolveShell(),
        skillsDir,
      });
    },

    async start(context, openOptions, artifactValue) {
      assertPosixHost();
      const artifact = requirePreparedHostArtifact(artifactValue);
      const cwd = resolveStartWorkingDirectory(context, options.cwd, openOptions?.cwd);
      await assertHostDirectoryExists(cwd, { goneOnMissing: false });
      const { skillsDir } = resolveHostSessionPaths(context);
      await materializeHostSkills(skillsDir, artifact.skills);
      const serializedEnv = serializeEnvOverrides(openOptions?.env);
      const connection = createHostConnection({
        cwd,
        environmentEnv: options.env,
        inheritEnv,
        loginShell,
        runtimeEnv: openOptions?.env,
        sessionKey: sessionRegistryKey(context),
        shell: resolveShell(),
        skillsDir,
      });
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
  readonly runtimeEnv?: Readonly<Record<string, string | undefined>>;
  readonly sessionKey: string;
  readonly shell: string;
  readonly skillsDir: string;
}): SandboxConnection {
  const { cwd, environmentEnv, inheritEnv, loginShell, runtimeEnv, sessionKey, shell, skillsDir } =
    input;
  const primaryArgs = loginShell ? ["-lc"] : ["-c"];
  const fastArgs = isBashShell(shell) ? ["--noprofile", "--norc", "-c"] : ["-c"];

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
    throwIfAborted(options.signal);
    const child = spawn(shell, [...argsPrefix, options.command], {
      cwd: options.workingDirectory,
      detached: true,
      env: commandEnv(options.env) as NodeJS.ProcessEnv,
      stdio: [options.stdin === true ? "pipe" : "ignore", "pipe", "pipe"],
    });
    if (options.stdin === true && child.stdin !== null) {
      child.stdin.on("error", () => {});
    }

    const tracked = trackHostChildProcess(sessionKey, child, options.signal);
    if (options.signal?.aborted) {
      await tracked.kill();
    }

    return {
      pid: child.pid,
      ...(options.stdin === true && child.stdin !== null
        ? { stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array> }
        : {}),
      stderr: Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>,
      stdout: Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
      kill: tracked.kill,
      wait: () => tracked.completed,
    };
  };

  const runBuffered = async (
    argsPrefix: readonly string[],
    options: ConnectionCommandOptions,
  ): Promise<SandboxCommandResult> => {
    throwIfAborted(options.signal);
    const child = spawn(shell, [...argsPrefix, options.command], {
      cwd: options.workingDirectory,
      detached: true,
      env: commandEnv(options.env) as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const tracked = trackHostChildProcess(sessionKey, child, options.signal);
    if (options.signal?.aborted) {
      await tracked.kill();
    }
    const { exitCode } = await tracked.completed;
    return {
      exitCode,
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    };
  };

  const connection: SandboxConnection = {
    workspaceRoot: cwd,
    async readFile({ path, signal }) {
      throwIfAborted(signal);
      try {
        return await readFile(path, { signal });
      } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") return null;
        throw error;
      }
    },
    async removePath(options: SandboxRemovePathOptions) {
      throwIfAborted(options.signal);
      await rm(options.path, {
        force: options.force === true,
        recursive: options.recursive === true,
      });
    },
    spawn: (options) => spawnWithArgs(primaryArgs, options),
    stop: () => stopSessionProcesses(sessionKey),
    async writeFiles(options: SandboxWriteFilesOptions) {
      for (const file of options.files) {
        throwIfAborted(options.signal);
        await mkdir(dirname(file.path), { recursive: true });
        await writeFile(file.path, file.content, { signal: options.signal });
      }
    },
  };

  return withConnectionFastPaths(connection, {
    runFast: (options) => runBuffered(fastArgs, options),
    runLogin: (options) => runBuffered(primaryArgs, options),
    skillsRoot: skillsDir,
    spawnBounded: (options) => spawnWithArgs(primaryArgs, options),
  });
}

function trackHostChildProcess(
  sessionKey: string,
  child: ChildProcess,
  signal: AbortSignal | undefined,
): {
  readonly completed: Promise<{ exitCode: number }>;
  kill(): Promise<void>;
} {
  let settled = false;
  let killing: Promise<void> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolveDone) => {
    resolveClosed = resolveDone;
  });

  const kill = (): Promise<void> => {
    if (settled || child.pid === undefined) return Promise.resolve();
    const pid = child.pid;
    killing ??= (async () => {
      sendGroupSignal(pid, "SIGTERM");
      const exitedInGrace = await Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolveTimeout) => {
          graceTimer = setTimeout(() => resolveTimeout(false), PROCESS_KILL_GRACE_MS);
          graceTimer.unref?.();
        }),
      ]);
      if (!exitedInGrace && !settled) {
        sendGroupSignal(pid, "SIGKILL");
        await closed;
      }
    })();
    return killing;
  };

  const tracked: TrackedHostProcess = { kill };
  const sessionProcesses = getOrCreateSessionProcesses(sessionKey);
  sessionProcesses.add(tracked);

  const onAbort = () => {
    void kill();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const completed = new Promise<{ exitCode: number }>((resolveDone, rejectDone) => {
    child.once("error", (error) => {
      rejectDone(error);
    });
    child.once("close", (code, signalName) => {
      if (signal?.aborted) {
        rejectDone(abortError(signal));
        return;
      }
      resolveDone({ exitCode: code ?? signalExitCode(signalName) });
    });
  }).finally(() => {
    settled = true;
    clearTimeout(graceTimer);
    resolveClosed();
    signal?.removeEventListener("abort", onAbort);
    const active = activeProcessesBySession.get(sessionKey);
    if (active !== undefined) {
      active.delete(tracked);
      if (active.size === 0) activeProcessesBySession.delete(sessionKey);
    }
  });
  completed.catch(() => {});

  return { completed, kill };
}

function getOrCreateSessionProcesses(sessionKey: string): Set<TrackedHostProcess> {
  let set = activeProcessesBySession.get(sessionKey);
  if (set === undefined) {
    set = new Set();
    activeProcessesBySession.set(sessionKey, set);
  }
  return set;
}

async function stopSessionProcesses(sessionKey: string): Promise<void> {
  const active = activeProcessesBySession.get(sessionKey);
  if (active === undefined) return;
  const processes = [...active];
  await Promise.allSettled(processes.map((proc) => proc.kill()));
}

function sendGroupSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ESRCH") {
      try {
        process.kill(pid, signal);
      } catch (fallbackError) {
        if (!isErrnoException(fallbackError) || fallbackError.code !== "ESRCH") {
          throw fallbackError;
        }
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
  if (runtimeCwd !== undefined) {
    if (runtimeCwd.trim().length === 0) {
      throw new Error("HostSandbox open `cwd` must be a non-empty directory path.");
    }
    return resolve(runtimeCwd);
  }
  if (environmentCwd !== undefined) {
    return isAbsolute(environmentCwd)
      ? resolve(environmentCwd)
      : context.resolveProjectPath(environmentCwd);
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
    if (isErrnoException(error) && error.code === "ENOENT") {
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

function resolveHostSessionPaths(context: SandboxSessionContext): {
  readonly sessionDir: string;
  readonly sessionsRoot: string;
  readonly skillsDir: string;
} {
  const hash = createSandboxProviderIdentity({
    sessionId: context.session.id,
    version: HOST_STATE_VERSION,
  }).slice(0, 24);
  const sessionsRoot = resolve(context.storagePath, HOST_CACHE_DIRECTORY_NAME, "sessions");
  const sessionDir = join(sessionsRoot, hash);
  return {
    sessionDir,
    sessionsRoot,
    skillsDir: join(sessionDir, "skills"),
  };
}

async function materializeHostSkills(
  skillsDir: string,
  skills: readonly HostSandboxPreparedSkillFile[] | undefined,
): Promise<void> {
  if (skills === undefined || skills.length === 0) return;
  for (const file of skills) {
    assertSafeRelativeSkillPath(file.path);
    const target = resolve(skillsDir, file.path);
    if (!isPathInsideOrEqual(target, skillsDir)) {
      throw new Error(`HostSandbox prepared skill path escapes skills directory: "${file.path}".`);
    }
    if (existsSync(target)) continue;
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, Buffer.from(file.contentBase64, "base64"));
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      if (!existsSync(target)) throw error;
    }
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
  overrides: Readonly<Record<string, string | undefined>> | undefined,
): void {
  if (overrides === undefined) return;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete target[key];
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

function deserializeEnvOverrides(
  overrides: SerializedEnvOverrides | undefined,
): Readonly<Record<string, string | undefined>> | undefined {
  if (overrides === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(overrides).map(([key, value]) => [key, value === null ? undefined : value]),
  );
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

function isBashShell(shell: string): boolean {
  return basename(shell) === "bash";
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}
