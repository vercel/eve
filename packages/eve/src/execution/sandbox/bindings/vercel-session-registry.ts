import type { VercelSandbox } from "#execution/sandbox/bindings/vercel-sdk-types.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

/**
 * This file is a TEMPORARY workaround for HarnessAgent requiring additional capabilities
 * on its `HarnessV1NetworkSandboxSession` type, which eve's `SandboxSession` does not
 * encompass.
 *
 * This file therefore registers each Vercel-backed `SandboxSession` with its underlying
 * `VercelSandbox` instance so that eve can construct the `HarnessV1NetworkSandboxSession`
 * for HarnessAgent.
 *
 * For now, this means HarnessAgent in eve can only be used with Vercel Sandbox.
 *
 * For a proper implementation, this would need to be implemented in an abstraction layer
 * so that any sandbox backend could support it.
 */

const VERCEL_SANDBOX_SESSION_REGISTRY_KEY = Symbol.for("eve.vercel-sandbox-session-registry");

type VercelSandboxSessionRegistryGlobal = typeof globalThis & {
  [VERCEL_SANDBOX_SESSION_REGISTRY_KEY]?: WeakMap<SandboxSession, VercelSandbox>;
};

const registryGlobal = globalThis as VercelSandboxSessionRegistryGlobal;
const registry = (registryGlobal[VERCEL_SANDBOX_SESSION_REGISTRY_KEY] ??= new WeakMap<
  SandboxSession,
  VercelSandbox
>());

export function registerVercelSandboxForSandboxSession(input: {
  readonly sandbox: VercelSandbox;
  readonly session: SandboxSession;
}): void {
  registry.set(input.session, input.sandbox);
}

export function getVercelSandboxForSandboxSession(input: {
  readonly session: SandboxSession;
}): VercelSandbox | undefined {
  return registry.get(input.session);
}
