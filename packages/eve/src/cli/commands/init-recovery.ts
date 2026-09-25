import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export type InitFailurePolicy = "clear" | "preserve" | "remove";

export async function cleanupFreshInitTarget(
  projectPath: string,
  policy: Exclude<InitFailurePolicy, "preserve">,
  preservedEntries: readonly string[] = [],
): Promise<boolean> {
  try {
    if (policy === "remove") {
      await rm(projectPath, { recursive: true, force: true });
    } else {
      const preserved = new Set(preservedEntries);
      for (const entry of await readdir(projectPath)) {
        if (!preserved.has(entry)) {
          await rm(join(projectPath, entry), { recursive: true, force: true });
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function workspaceFailureNote(workspaceMember: boolean): string {
  return workspaceMember
    ? "\n\nShared workspace files may have changed. Review your workspace changes before committing."
    : "";
}
