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
const VERCEL_SANDBOX_SESSION_TOKEN_KEY = Symbol.for("eve.vercel-sandbox-session-token");

type VercelSandboxSessionRegistryGlobal = typeof globalThis & {
  [VERCEL_SANDBOX_SESSION_REGISTRY_KEY]?: WeakMap<object, VercelSandbox>;
};

const registryGlobal = globalThis as VercelSandboxSessionRegistryGlobal;
const registry = (registryGlobal[VERCEL_SANDBOX_SESSION_REGISTRY_KEY] ??= new WeakMap<
  object,
  VercelSandbox
>());

function getVercelSandboxSessionToken(session: SandboxSession): object | undefined {
  const token = Reflect.get(session, VERCEL_SANDBOX_SESSION_TOKEN_KEY);
  return typeof token === "object" && token !== null ? token : undefined;
}

export function registerVercelSandboxForSandboxSession(input: {
  readonly sandbox: VercelSandbox;
  readonly session: SandboxSession;
}): void {
  let token = getVercelSandboxSessionToken(input.session);
  if (token === undefined) {
    token = Object.freeze({});
    Object.defineProperty(input.session, VERCEL_SANDBOX_SESSION_TOKEN_KEY, { value: token });
  }
  registry.set(token, input.sandbox);
}

export function getVercelSandboxForSandboxSession(input: {
  readonly session: SandboxSession;
}): VercelSandbox | undefined {
  const token = getVercelSandboxSessionToken(input.session);
  return token === undefined ? undefined : registry.get(token);
}
