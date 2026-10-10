import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";
import type { SandboxProviderHandle, SandboxProviderRuntime } from "#shared/sandbox-provider.js";

/*
 * Keyed tool sessions reuse a provider's own `start`, which must find the
 * session's sandbox again from the session id alone. Only eve's bindings that
 * do so opt in, and the marker stays internal so the public provider API is
 * unchanged.
 */

/** What a binding that keeps tool-session sandboxes tells the calls that use them. */
export interface ToolSessionSandboxSupport {
  /**
   * Frees what a call's handle holds in this process once the call ends,
   * leaving the session's sandbox for later and overlapping calls. Absent
   * when a handle holds nothing of its own, such as a client to a remote
   * sandbox.
   */
  releaseHandle?(handle: SandboxProviderHandle): Promise<void>;
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
