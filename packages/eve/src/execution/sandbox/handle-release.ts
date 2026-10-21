/*
 * A caller that borrows a session's sandbox, such as a workflow step, opens
 * its own provider handle and must free what that handle holds in this
 * process without stopping the sandbox the session keeps. Bindings whose
 * handles hold something of their own attach that release here; a handle
 * that is only a client to a remote sandbox needs none. `Symbol.for`, not a
 * module-local WeakMap: a workflow step runs from a different bundled copy
 * of this module than the binding that made the handle.
 */
const RELEASE = Symbol.for("eve.sandbox.handle-release");

type ReleasableHandle = { [RELEASE]?: () => Promise<void> };

/** Attaches what frees this handle's own resources, leaving the sandbox itself running. */
export function withHandleRelease<Handle extends object>(
  handle: Handle,
  release: () => Promise<void>,
): Handle {
  Object.defineProperty(handle, RELEASE, { configurable: true, enumerable: false, value: release });
  return handle;
}

/** Frees what a borrowed handle holds in this process, if its binding attached a release. */
export async function releaseSandboxHandle(handle: object): Promise<void> {
  await (handle as ReleasableHandle)[RELEASE]?.();
}
