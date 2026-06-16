import type { SandboxBackend } from "#public/definitions/sandbox-backend.js";

/**
 * Wraps a backend-producing function in a `SandboxBackend` proxy that
 * invokes the function exactly once, on first access to any of `.name`,
 * `.create`, or `.prewarm`. Subsequent accesses return the same cached
 * underlying backend.
 *
 * Used by `defaultSandbox()` for env-conditional selection, and by the
 * authored-definition normalizer when an author passes a callback to
 * `SandboxDefinition.backend` (e.g. `backend: () => vercel({...})`)
 * so the factory runs at first use rather than at module load — while
 * still preserving backend-internal state (such as the Vercel backend's
 * prewarmed-templates map) across every framework call.
 */
export function lazyBackend<BO, SO>(factory: () => SandboxBackend<BO, SO>): SandboxBackend<BO, SO> {
  let resolved: SandboxBackend<BO, SO> | undefined;

  function resolve(): SandboxBackend<BO, SO> {
    if (resolved === undefined) {
      resolved = factory();
    }
    return resolved;
  }

  return {
    get name() {
      return resolve().name;
    },
    create(input) {
      return resolve().create(input);
    },
    prewarm(input) {
      return resolve().prewarm(input);
    },
  };
}
