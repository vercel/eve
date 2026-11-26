import type { SandboxConnection } from "#sandbox/provider.js";
import type { SandboxCommandResult, SandboxRunOptions } from "#shared/sandbox-session.js";

export interface ConnectionFastRunOptions {
  readonly signal?: AbortSignal;
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
  readonly workingDirectory: string;
}

export type ConnectionFastRun = (
  options: ConnectionFastRunOptions,
) => Promise<SandboxCommandResult>;

export type SessionFastRun = (options: SandboxRunOptions) => Promise<SandboxCommandResult>;

const connectionFastRunners = new WeakMap<SandboxConnection<object>, ConnectionFastRun>();
const sessionFastRunners = new WeakMap<object, SessionFastRun>();

export function withConnectionFastRun<Connection extends SandboxConnection<object>>(
  connection: Connection,
  run: ConnectionFastRun,
): Connection {
  connectionFastRunners.set(connection, run);
  return connection;
}

export function connectionFastRun(
  connection: SandboxConnection<object>,
): ConnectionFastRun | undefined {
  return connectionFastRunners.get(connection);
}

export function withSessionFastRun<Session extends object>(
  session: Session,
  run: SessionFastRun,
): Session {
  sessionFastRunners.set(session, run);
  return session;
}

export function forwardSessionFastRun<Target extends object>(
  source: object,
  target: Target,
  wrap?: (run: SessionFastRun) => SessionFastRun,
): Target {
  const runner = sessionFastRunners.get(source);
  if (runner !== undefined) {
    sessionFastRunners.set(target, wrap === undefined ? runner : wrap(runner));
  }
  return target;
}

export async function runInternalCommand(
  sandbox: { readonly run: (options: SandboxRunOptions) => PromiseLike<SandboxCommandResult> },
  options: SandboxRunOptions,
): Promise<SandboxCommandResult> {
  const runner = sessionFastRunners.get(sandbox);
  if (runner !== undefined) {
    return await runner(options);
  }
  return await sandbox.run(options);
}
