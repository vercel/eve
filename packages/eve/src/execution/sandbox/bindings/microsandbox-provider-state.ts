import type { MicrosandboxModule } from "#execution/sandbox/bindings/microsandbox-runtime.js";

/**
 * Classifies provider errors by message because the microsandbox SDK
 * exposes no structured error codes for these conditions.
 */
export function isMicrosandboxNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /not found|not exist|no such/i.test(error.message);
}

export function isMicrosandboxStillRunningError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /still running/i.test(error.message);
}

export function isMicrosandboxSnapshotSourceRunningError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /snapshot source sandbox .*not stopped|SnapshotSandboxRunning/i.test(error.message);
}

export async function snapshotExists(
  module: MicrosandboxModule,
  snapshotName: string,
): Promise<boolean> {
  try {
    await module.Snapshot.get(snapshotName);
    return true;
  } catch {
    return false;
  }
}

export async function sandboxExists(
  module: MicrosandboxModule,
  sandboxName: string,
): Promise<boolean> {
  try {
    await module.Sandbox.get(sandboxName);
    return true;
  } catch (error) {
    if (isMicrosandboxNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

export async function removeSnapshotIfExists(
  module: MicrosandboxModule,
  snapshotName: string,
): Promise<void> {
  try {
    await module.Snapshot.remove(snapshotName, { force: true });
  } catch (error) {
    if (!isMicrosandboxNotFoundError(error)) {
      throw error;
    }
  }
}
