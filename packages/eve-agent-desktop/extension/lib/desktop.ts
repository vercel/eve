import {
  AGENT_DESKTOP_VERSION,
  DEFAULT_AGENT_DESKTOP_INSTALL_SPEC,
  desktopEnvPrefix,
  desktopReadyCommand,
  installAgentDesktop,
  quoteShellArg,
  startDesktop,
  type DesktopSandbox,
} from "./sandbox";

import { CALL_DEADLINE_MS, runCommand, untilSettled } from "./process";
import extension from "../extension";
import type { ToolContext } from "eve/tools";
import type { SandboxSession } from "eve/sandbox";

export type DesktopToolContext = Pick<ToolContext, "abortSignal" | "session" | "getSandbox">;

/** agent-desktop's JSON envelope: one per command on stdout. */
interface Envelope {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly suggestion?: string;
    readonly disposition?: { readonly delivery?: string; readonly retry?: string };
  };
}

/**
 * Everything one tool call may use. The signal carries the call's whole budget
 * and its cancellation, and `run` is the only way to reach the CLI, so install,
 * desktop start and post-processing all sit inside the same deadline.
 */
export interface DesktopCall {
  readonly sandbox: Pick<SandboxSession, "spawn" | "readBinaryFile" | "removePath">;
  readonly signal: AbortSignal;
  run<TData = unknown>(args: readonly string[]): Promise<TData>;
}

/**
 * Install specs that recently failed, keyed by the sandbox that failed. In a
 * process serving many sessions, one sandbox's failure must not stop another
 * from installing the same spec. Retrying on every call would repeat a slow
 * apt and npm run, so a failure is reported again until it is a few minutes
 * old.
 */
const failedInstalls = new Map<string, { readonly error: Error; readonly at: number }>();
const INSTALL_RETRY_AFTER_MS = 300_000;
const pendingSetups = new Map<string, Promise<void>>();

/**
 * Prepare the sandbox for one tool call and hand the caller its scope: the
 * desktop is installed and running, the deadline signal has started, and every
 * command goes through it.
 */
export async function withDesktopCall<T>(
  ctx: DesktopToolContext,
  work: (call: DesktopCall) => Promise<T>,
): Promise<T> {
  const deadline = AbortSignal.timeout(CALL_DEADLINE_MS);
  const signal = ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, deadline]) : deadline;
  const sandbox = await untilSettled(ctx.getSandbox(), signal);
  await prepareSandbox(sandbox, signal, ctx.session.id);

  const call: DesktopCall = {
    sandbox,
    signal,
    run: (args) => runAgentDesktop(sandbox, args, signal),
  };
  return await untilSettled(work(call), signal);
}

/**
 * Run one agent-desktop command and return the `data` of its envelope. A
 * structured error becomes a thrown Error that keeps the code, suggestion and
 * retry disposition, so the model can decide whether a retry is safe.
 */
async function runAgentDesktop<TData = unknown>(
  sandbox: DesktopSandbox,
  args: readonly string[],
  signal: AbortSignal,
): Promise<TData> {
  const config = extension.config;
  const command = [
    desktopEnvPrefix(config.display, config.manageDesktop),
    [config.binary, ...(config.headed ? ["--headed"] : []), ...args].map(quoteShellArg).join(" "),
  ].join("; ");
  const raw = await runCommand(sandbox, command, signal);
  return parseEnvelope<TData>(raw.stdout ?? "", raw.stderr ?? "", args[0] ?? "command");
}

function parseEnvelope<TData>(stdout: string, stderr: string, name: string): TData {
  let envelope: Envelope;
  try {
    envelope = JSON.parse(stdout.trim()) as Envelope;
  } catch {
    throw new Error(
      `agent-desktop ${name} printed no JSON envelope.\n${(stderr.trim() || stdout.trim()).slice(-2000)}`,
    );
  }
  if (envelope.ok) return (envelope.data ?? null) as TData;
  const error = envelope.error;
  if (error === undefined) throw new Error(`agent-desktop ${name} failed without an error.`);
  const retry = error.disposition?.retry ?? "unknown";
  const delivery = error.disposition?.delivery ?? "unknown";
  throw new Error(
    [
      `agent-desktop ${name} failed: ${error.code}: ${error.message}`,
      error.suggestion ? `Suggestion: ${error.suggestion}` : undefined,
      `Delivery: ${delivery}; retry: ${retry}.${retry === "safe" ? "" : " Do not repeat this action blindly: read the live state first."}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

async function prepareSandbox(
  sandbox: DesktopSandbox,
  signal: AbortSignal,
  sessionId: string,
): Promise<void> {
  const previous = pendingSetups.get(sessionId) ?? Promise.resolve();
  const config = extension.config;
  const pending = previous
    .catch(() => undefined)
    .then(async () => {
      signal.throwIfAborted();
      if (config.autoInstall) await ensureInstalled(sandbox, signal, sessionId);
      if (config.manageDesktop) await ensureDesktop(sandbox, signal);
    });
  pendingSetups.set(sessionId, pending);
  const clear = () => {
    if (pendingSetups.get(sessionId) === pending) pendingSetups.delete(sessionId);
  };
  void pending.then(clear, clear);
  await untilSettled(pending, signal);
}

async function ensureInstalled(
  sandbox: DesktopSandbox,
  signal: AbortSignal,
  sessionId: string,
): Promise<void> {
  const config = extension.config;
  const installed = await probeVersion(sandbox, signal);
  if (installed !== undefined && matchesPackageMinor(installed)) return;

  // A custom binary is the app's to install; never replace it with the default package.
  if (config.binary !== "agent-desktop") {
    throw installed === undefined
      ? new Error(`agent-desktop binary ${config.binary} was not found in the sandbox.`)
      : versionMismatchError(installed);
  }
  // Reinstalling a custom spec would install the same mismatched version again.
  if (installed !== undefined && config.installSpec !== undefined)
    throw versionMismatchError(installed);

  const spec = config.installSpec ?? DEFAULT_AGENT_DESKTOP_INSTALL_SPEC;
  const key = `${sessionId}\u0000${spec}`;
  const failed = failedInstalls.get(key);
  if (failed !== undefined && Date.now() - failed.at < INSTALL_RETRY_AFTER_MS) throw failed.error;
  try {
    await installAgentDesktop(sandbox, {
      signal,
      installSpec: config.installSpec,
      installDesktop: config.installDesktop,
      extraPackages: config.extraPackages,
    });
    const reinstalled = await probeVersion(sandbox, signal);
    if (reinstalled === undefined || !matchesPackageMinor(reinstalled))
      throw versionMismatchError(reinstalled ?? "missing");
    failedInstalls.delete(key);
  } catch (error) {
    if (!signal.aborted) rememberFailedInstall(key, error as Error);
    throw error;
  }
}

function rememberFailedInstall(key: string, error: Error): void {
  const now = Date.now();
  for (const [remembered, failure] of failedInstalls) {
    if (now - failure.at >= INSTALL_RETRY_AFTER_MS) failedInstalls.delete(remembered);
  }
  failedInstalls.set(key, { error, at: now });
}

async function ensureDesktop(sandbox: DesktopSandbox, signal: AbortSignal): Promise<void> {
  const display = extension.config.display;
  // One cheap check when the desktop is live; a resumed sandbox loses its processes and starts them again here.
  const ready = await runCommand(sandbox, desktopReadyCommand(display), signal);
  if ((ready.exitCode ?? 0) === 0) return;
  await startDesktop(sandbox, { signal, display });
}

/** The installed CLI version, or undefined when the binary is missing. */
async function probeVersion(
  sandbox: DesktopSandbox,
  signal: AbortSignal,
): Promise<string | undefined> {
  const probe = await runCommand(
    sandbox,
    `${quoteShellArg(extension.config.binary)} --version 2>/dev/null`,
    signal,
  );
  if ((probe.exitCode ?? 0) !== 0) return undefined;
  return (probe.stdout ?? "").trim().split(/\s+/).at(-1) ?? "";
}

/** These tools describe one agent-desktop minor; another minor may take different flags. */
function matchesPackageMinor(version: string): boolean {
  const minor = (v: string) => v.split(".").slice(0, 2).join(".");
  return minor(version) === minor(AGENT_DESKTOP_VERSION);
}

function versionMismatchError(installed: string): Error {
  return new Error(
    `agent-desktop ${installed} in the sandbox does not match @eve/agent-desktop (agent-desktop ${AGENT_DESKTOP_VERSION}). Install agent-desktop@${AGENT_DESKTOP_VERSION} or set installSpec to it.`,
  );
}
