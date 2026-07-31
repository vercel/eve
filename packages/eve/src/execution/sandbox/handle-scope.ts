import { trackActiveSandboxHandle } from "#execution/sandbox/active-handles.js";
import type { SandboxStateValue } from "#sandbox/state.js";
import {
  getSandboxAdapterType,
  getSandboxResourceId,
  isSandboxActivated,
  onSandboxActivated,
  requiresSandboxShutdown,
  restoreSandbox,
  serializeSandbox,
  shutdownSandbox,
  type Sandbox,
  type SerializedSandbox,
} from "#shared/sandbox-value.js";

interface SandboxHandleScope {
  capture(sandbox: Sandbox): Promise<SerializedSandbox>;
  restoreAncestor(state: SandboxStateValue): Sandbox;
  restoreCurrent(value: SerializedSandbox, tags?: Readonly<Record<string, string>>): Sandbox;
  track(sandbox: Sandbox): void;
}

export function createSandboxHandleScope(input: {
  readonly appRoot: string;
  readonly signal: AbortSignal;
}): SandboxHandleScope {
  const ancestors = new Map<string, Sandbox>();
  const restoredValues = new WeakMap<Sandbox, SerializedSandbox>();
  const tracked = new WeakSet<Sandbox>();

  function restore(value: SerializedSandbox, tags?: Readonly<Record<string, string>>): Sandbox {
    const sandbox = restoreSandbox(value, {
      appRoot: input.appRoot,
      signal: input.signal,
      tags,
    });
    restoredValues.set(sandbox, value);
    track(sandbox);
    return sandbox;
  }

  function track(sandbox: Sandbox): void {
    if (tracked.has(sandbox) || !requiresSandboxShutdown(sandbox)) {
      return;
    }
    tracked.add(sandbox);
    onSandboxActivated(sandbox, () => {
      trackActiveSandboxHandle({
        provider: getSandboxAdapterType(sandbox),
        resourceId: getSandboxResourceId(sandbox),
        handle: {
          async shutdown() {
            await shutdownSandbox(sandbox);
          },
        },
      });
    });
  }

  return {
    async capture(sandbox) {
      const restoredValue = isSandboxActivated(sandbox) ? undefined : restoredValues.get(sandbox);
      return restoredValue ?? (await serializeSandbox(sandbox));
    },
    restoreAncestor(state) {
      const key = `${state.value.adapterId}\0${state.value.resourceId}`;
      const existing = ancestors.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const sandbox = restore(state.value);
      ancestors.set(key, sandbox);
      return sandbox;
    },
    restoreCurrent(value, tags) {
      return restore(value, tags);
    },
    track,
  };
}
