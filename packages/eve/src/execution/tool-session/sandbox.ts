import { createLogger } from "#internal/logging.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";
import type { SandboxProviderHandle, SandboxProviderRuntime } from "#shared/sandbox-provider.js";

const log = createLogger("tool-session.sandbox");

const DAY_MS = 24 * 60 * 60 * 1000;

/** Idle time after which the sweep deletes a tool-session sandbox. */
export const TOOL_SESSION_SANDBOX_EXPIRY_MS = 30 * DAY_MS;

/*
 * Keyed tool sessions reuse a provider's own `start`, which must find the
 * session's sandbox again from the session id alone. Only eve's bindings that
 * do so opt in, and the marker stays internal so the public provider API is
 * unchanged.
 */

/** One tool-session sandbox, as the provider last saw it. */
export interface ToolSessionSandboxSummary {
  /** Epoch milliseconds of its most recent use. */
  readonly lastUsedAt: number;
  readonly name: string;
  readonly running: boolean;
  readonly sessionId: string | undefined;
}

/**
 * How a provider lists and deletes tool-session sandboxes for the sweep. A
 * sweeper closes over whatever it needs to reach them (credentials, SDK).
 */
export interface ToolSessionSandboxSweeper {
  list(): Promise<readonly ToolSessionSandboxSummary[]>;
  /**
   * Deletes the named sandbox unless `keep` says otherwise. `keep` is asked
   * about the provider's last read, immediately before the delete request,
   * so a sandbox a call resumed since the listing is kept. Returns whether it
   * deleted the sandbox.
   */
  deleteUnless(
    name: string,
    keep: (current: ToolSessionSandboxSummary) => boolean,
  ): Promise<boolean>;
}

/** What a binding that keeps tool-session sandboxes tells the calls that use them. */
export interface ToolSessionSandboxSupport {
  /**
   * Frees what a call's handle holds in this process once the call ends,
   * leaving the session's sandbox for later and overlapping calls. Absent
   * when a handle holds nothing of its own, such as a client to a remote
   * sandbox.
   */
  releaseHandle?(handle: SandboxProviderHandle): Promise<void>;
  /** Lists and deletes the session sandboxes for the sweep; absent when there is nothing to sweep. */
  readonly sweeper?: ToolSessionSandboxSweeper;
}

const supported = new WeakMap<object, ToolSessionSandboxSupport>();

/** Marks a binding whose `start` reopens a session's sandbox by session id. */
export function withToolSessionSandboxes<Implementation extends object>(
  implementation: Implementation,
  support: ToolSessionSandboxSupport = {},
): Implementation {
  supported.set(implementation, support);
  return implementation;
}

/** Raised when a keyed tool session opens a sandbox on a provider that cannot keep it. */
export class ToolSessionSandboxUnsupportedError extends Error {
  constructor(providerName: string) {
    super(
      `Sandbox provider "${providerName}" cannot keep a sandbox between invokeTool calls, ` +
        "so a call with a key cannot open one. Call without a key for a sandbox that lasts " +
        "one call, or use Vercel Sandbox or just-bash.",
    );
    this.name = "ToolSessionSandboxUnsupportedError";
  }
}

/** Throws unless the registry's sandbox provider can keep tool-session sandboxes. */
export function assertToolSessionSandboxSupport(registry: RuntimeSandboxRegistry): void {
  const provider = registeredProvider(registry);
  if (provider !== undefined && !supported.has(provider.implementation)) {
    throw new ToolSessionSandboxUnsupportedError(provider.providerName);
  }
}

/** Frees what a keyed call's handle holds in this process; the sandbox itself stays. */
export async function releaseToolSessionHandle(
  registry: RuntimeSandboxRegistry,
  handle: SandboxProviderHandle,
): Promise<void> {
  const provider = registeredProvider(registry);
  if (provider === undefined) return;
  await supported.get(provider.implementation)?.releaseHandle?.(handle);
}

function registeredProvider(registry: RuntimeSandboxRegistry): SandboxProviderRuntime | undefined {
  const registered = registry.sandbox;
  const definition = registered?.inheritance?.definition ?? registered?.definition;
  if (definition?.kind !== "independent") return undefined;
  return getSandboxEnvironmentRuntime(definition.environment);
}

// Tool sessions with a call in flight in this process, with a holder count.
const leases = new Map<string, number>();

/** Holds a tool session against the sweep until the returned release runs. */
export function leaseToolSession(sessionId: string): () => void {
  leases.set(sessionId, (leases.get(sessionId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const holders = (leases.get(sessionId) ?? 1) - 1;
    if (holders <= 0) leases.delete(sessionId);
    else leases.set(sessionId, holders);
  };
}

/** Result of one {@link sweepToolSessionSandboxes} pass. */
export interface ToolSessionSandboxSweepResult {
  readonly deleted: readonly string[];
  readonly failed: readonly string[];
  /** Why nothing was swept, when the provider cannot list its tool-session sandboxes. */
  readonly skipped?: string;
}

/**
 * Deletes tool-session sandboxes unused for longer than `expiryMs`. A tool
 * session has no end to delete its sandbox at, so this bounds retention.
 * Production builds on Vercel Sandbox run it weekly as a Nitro task.
 *
 * A sandbox that is running, used since the cutoff, or leased by a call in
 * this process is kept, checked again at the provider's final read. Another
 * instance holds no lease the sweep can see; a call there that resumes a
 * sandbox idle past the expiry between that read and the delete loses it,
 * as it would after expiry.
 */
export async function sweepToolSessionSandboxes(input: {
  readonly expiryMs?: number;
  readonly now?: number;
  readonly registry: RuntimeSandboxRegistry;
}): Promise<ToolSessionSandboxSweepResult> {
  const provider = registeredProvider(input.registry);
  if (provider === undefined) {
    return { deleted: [], failed: [], skipped: "The agent has no sandbox of its own." };
  }
  const sweeper = supported.get(provider.implementation)?.sweeper;
  if (sweeper === undefined) {
    return {
      deleted: [],
      failed: [],
      skipped: `Sandbox provider "${provider.providerName}" cannot list tool-session sandboxes.`,
    };
  }
  const cutoff = (input.now ?? Date.now()) - (input.expiryMs ?? TOOL_SESSION_SANDBOX_EXPIRY_MS);
  const keep = (sandbox: ToolSessionSandboxSummary) =>
    sandbox.running ||
    sandbox.lastUsedAt >= cutoff ||
    (sandbox.sessionId !== undefined && leases.has(sandbox.sessionId));
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const summary of await sweeper.list()) {
    if (keep(summary)) continue;
    try {
      if (await sweeper.deleteUnless(summary.name, keep)) deleted.push(summary.name);
    } catch (error) {
      failed.push(summary.name);
      log.warn("failed to delete an idle tool-session sandbox", {
        error: error instanceof Error ? error.message : String(error),
        sandboxName: summary.name,
      });
    }
  }
  return { deleted, failed };
}
