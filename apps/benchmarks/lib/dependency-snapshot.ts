import type { Sandbox } from "@vercel/sandbox";

export async function dependencySnapshotId(
  sandbox: Pick<Sandbox, "currentSnapshotId" | "snapshot">,
): Promise<string> {
  if (sandbox.currentSnapshotId !== undefined) return sandbox.currentSnapshotId;
  return (await sandbox.snapshot({ expiration: 0 })).snapshotId;
}
