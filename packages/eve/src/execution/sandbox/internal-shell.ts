import type { SandboxConnection } from "#sandbox/provider.js";
import type {
  SandboxCommandResult,
  SandboxProcess,
  SandboxRunOptions,
  SandboxSpawnOptions,
} from "#shared/sandbox-session.js";

export interface ConnectionCommandOptions {
  readonly signal?: AbortSignal;
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
  readonly workingDirectory: string;
}

export type ConnectionCommandRunner = (
  options: ConnectionCommandOptions,
) => Promise<SandboxCommandResult>;

export type ConnectionBoundedSpawner = (
  options: ConnectionCommandOptions,
) => Promise<SandboxProcess>;

export interface ConnectionFastPaths {
  readonly jobsRoot?: string;
  readonly runFast?: ConnectionCommandRunner;
  readonly runLogin?: ConnectionCommandRunner;
  readonly skillsRoot?: string;
  readonly spawnBounded?: ConnectionBoundedSpawner;
}

export interface InternalCommandOptions extends SandboxRunOptions {
  readonly maxOutputBytes?: number;
}

export type SessionCommandRunner = (
  options: InternalCommandOptions,
) => Promise<SandboxCommandResult>;

export type SessionBoundedSpawner = (options: SandboxSpawnOptions) => Promise<SandboxProcess>;

export interface SessionFastPaths {
  readonly jobsRoot?: string;
  readonly runFast?: SessionCommandRunner;
  readonly skillsRoot?: string;
  readonly spawnBounded?: SessionBoundedSpawner;
}

const connectionFastPaths = new WeakMap<SandboxConnection<object>, ConnectionFastPaths>();
const sessionFastPaths = new WeakMap<object, SessionFastPaths>();

export function withConnectionFastPaths<Connection extends SandboxConnection<object>>(
  connection: Connection,
  paths: ConnectionFastPaths,
): Connection {
  connectionFastPaths.set(connection, paths);
  return connection;
}

export function getConnectionFastPaths(
  connection: SandboxConnection<object>,
): ConnectionFastPaths | undefined {
  return connectionFastPaths.get(connection);
}

export function withSessionFastPaths<Session extends object>(
  session: Session,
  paths: SessionFastPaths,
): Session {
  sessionFastPaths.set(session, paths);
  return session;
}

export function getSessionJobsRoot(sandbox: object): string | undefined {
  return sessionFastPaths.get(sandbox)?.jobsRoot;
}

export function getSessionSkillsRoot(sandbox: object): string | undefined {
  return sessionFastPaths.get(sandbox)?.skillsRoot;
}

export function forwardSessionFastPaths<Target extends object>(
  source: object,
  target: Target,
  wrapSignal?: (signal: AbortSignal | undefined) => AbortSignal,
): Target {
  const paths = sessionFastPaths.get(source);
  if (paths === undefined) return target;
  if (wrapSignal === undefined) {
    sessionFastPaths.set(target, paths);
    return target;
  }
  const { jobsRoot, runFast, skillsRoot, spawnBounded } = paths;
  sessionFastPaths.set(target, {
    ...(jobsRoot !== undefined && { jobsRoot }),
    ...(runFast !== undefined && {
      runFast: (options) => runFast({ ...options, signal: wrapSignal(options.signal) }),
    }),
    ...(skillsRoot !== undefined && { skillsRoot }),
    ...(spawnBounded !== undefined && {
      spawnBounded: (options) => spawnBounded({ ...options, signal: wrapSignal(options.signal) }),
    }),
  });
  return target;
}

export async function runInternalCommand(
  sandbox: { readonly run: (options: SandboxRunOptions) => PromiseLike<SandboxCommandResult> },
  options: InternalCommandOptions,
): Promise<SandboxCommandResult> {
  const runner = sessionFastPaths.get(sandbox)?.runFast;
  if (runner !== undefined) {
    return await runner(options);
  }
  const { maxOutputBytes: _maxOutputBytes, ...runOptions } = options;
  return await sandbox.run(runOptions);
}

export async function spawnBoundedCommand(
  sandbox: { readonly spawn: (options: SandboxSpawnOptions) => PromiseLike<SandboxProcess> },
  options: SandboxSpawnOptions,
): Promise<SandboxProcess> {
  const spawner = sessionFastPaths.get(sandbox)?.spawnBounded;
  if (spawner !== undefined && options.stdin !== true) {
    return await spawner(options);
  }
  return await sandbox.spawn(options);
}
