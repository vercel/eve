import type { SandboxSession } from "eve/sandbox";

/** One file per directory, like pi: AGENTS.md wins, CLAUDE.md is the fallback. */
const FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

/** Repository content reaches every turn's prompt, so its size is bounded. */
const MAX_CHARACTERS = 64_000;

export interface ProjectInstructionsFile {
  readonly path: string;
  readonly content: string;
}

/** Reads the workspace root's `AGENTS.md`, or `CLAUDE.md` when it has none. */
export async function readProjectInstructions(
  sandbox: Pick<SandboxSession, "readTextFile" | "resolvePath">,
): Promise<ProjectInstructionsFile | null> {
  for (const name of FILE_NAMES) {
    const path = sandbox.resolvePath(name);
    const content = await sandbox.readTextFile({ path });
    if (content === null || content.trim() === "") continue;
    return {
      path,
      content:
        content.length > MAX_CHARACTERS
          ? `${content.slice(0, MAX_CHARACTERS)}\n\n[truncated: read ${path} for the rest]`
          : content,
    };
  }
  return null;
}

/** pi's project context format, so models see repository guidance the way coding harnesses show it. */
export function formatProjectInstructions(file: ProjectInstructionsFile): string {
  return [
    "Project-specific instructions and guidelines:",
    `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`,
  ].join("\n\n");
}
