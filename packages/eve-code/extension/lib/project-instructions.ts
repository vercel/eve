import type { SandboxSession } from "eve/sandbox";

import { commandFailureDetail } from "./command-failure.ts";

const FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

const MAX_BYTES = 64_000;

export interface ProjectInstructionsFile {
  readonly path: string;
  readonly content: string;
}

export async function readProjectInstructions(
  sandbox: Pick<SandboxSession, "resolvePath" | "run">,
): Promise<ProjectInstructionsFile | null> {
  const paths = FILE_NAMES.map((name) => shellQuote(sandbox.resolvePath(name))).join(" ");
  const result = await sandbox.run({
    command: `for f in ${paths}; do if [ -f "$f" ] && [ -s "$f" ]; then printf '%s\\n' "$f"; head -c ${MAX_BYTES + 1} -- "$f"; exit 0; fi; done`,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Could not read project instructions: ${commandFailureDetail(result)}`);
  }
  const newline = result.stdout.indexOf("\n");
  if (newline === -1) return null;
  const path = result.stdout.slice(0, newline);
  const content = result.stdout.slice(newline + 1);
  if (content.trim() === "") return null;
  const bytes = Buffer.from(content);
  return {
    path,
    content:
      bytes.length > MAX_BYTES
        ? `${bytes.subarray(0, MAX_BYTES).toString()}\n\n[truncated: read ${path} for the rest]`
        : content,
  };
}

export function formatProjectInstructions(file: ProjectInstructionsFile): string {
  return [
    "Project-specific instructions and guidelines:",
    `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`,
  ].join("\n\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
