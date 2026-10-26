import type { WorkspaceRuntimeSpec } from "#runtime/workspace/types.js";

/**
 * Creates the authored-workspace prompt section that advertises the authored
 * paths visible at the workspace root.
 */
export function createWorkspacePromptSection(spec: WorkspaceRuntimeSpec): string | undefined {
  if (spec.rootEntries.length === 0) {
    return undefined;
  }

  const lines = [
    "Workspace",
    "- You have access to authored files mounted at the workspace root for this run.",
    "- The workspace root is the directory where `bash` commands start; `pwd` prints its absolute path.",
    "- Root entries under the workspace root:",
    ...spec.rootEntries.map((entry) => `  - ${entry}`),
    "- For questions about workspace paths or file availability, verify with `bash` first using commands like `pwd`, `ls`, and `find`.",
    "- If the required `bash` verification fails, report that failure directly instead of answering from this overview.",
    "- Use the `bash` tool with `ls`, `find`, and `rg` to inspect deeper contents when needed.",
    "- Do not claim these files are unavailable unless a workspace or tool call actually fails.",
  ];

  return lines.join("\n");
}
