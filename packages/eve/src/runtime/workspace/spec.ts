import { WORKSPACE_ROOT, type WorkspaceRuntimeSpec } from "#runtime/workspace/types.js";

/**
 * Creates the authored-workspace prompt section that advertises the authored
 * paths visible at the agent's seeded workspace root.
 *
 * `seededWorkspaceRoot` is where this agent's authored files were placed.
 * For the sandbox-owning agent it is the shared `/workspace`. For an agent
 * with a dedicated home it is `$HOME/workspace`, and the section explains
 * that the live cwd is still the shared `/workspace`.
 */
export function createWorkspacePromptSection(
  spec: WorkspaceRuntimeSpec,
  seededWorkspaceRoot: string = WORKSPACE_ROOT,
): string | undefined {
  if (spec.rootEntries.length === 0) {
    return undefined;
  }

  const seededPrivately = seededWorkspaceRoot !== WORKSPACE_ROOT;
  const lines = [
    "Workspace",
    `- You have access to authored files mounted at \`${seededWorkspaceRoot}\` for this run.`,
    `- The live workspace root visible to \`bash\` in this run is \`${WORKSPACE_ROOT}\`.`,
    ...(seededPrivately
      ? [
          `- \`${WORKSPACE_ROOT}\` is shared with the agent that dispatched you; \`${seededWorkspaceRoot}\` is private to you.`,
        ]
      : []),
    `- Root entries under ${seededWorkspaceRoot}/:`,
    ...spec.rootEntries.map((entry) => `  - ${entry}`),
    `- Treat \`${WORKSPACE_ROOT}\` as the workspace root for this run unless a \`bash\` call shows otherwise.`,
    "- For questions about workspace paths or file availability, verify with `bash` first using commands like `pwd`, `ls`, and `find`.",
    "- If the required `bash` verification fails, report that failure directly instead of answering from this overview.",
    "- Use the `bash` tool with `ls`, `find`, and `rg` to inspect deeper contents when needed.",
    "- Do not claim these files are unavailable unless a workspace or tool call actually fails.",
  ];

  return lines.join("\n");
}
