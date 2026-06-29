import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it } from "vitest";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_SOURCE_FILE_LINES = 700;

// Existing long files are baseline debt. This set should only shrink.
const LONG_SOURCE_FILE_ALLOWLIST = new Set<string>([
  "cli/dev/tui/runner.ts",
  // TODO: split by concern — tipped over the cap when the Vercel project-picker
  // search rendering landed on top of origin/main. Extract the panel-state types
  // or the text/acknowledge renderers, then drop this entry.
  "cli/dev/tui/setup-panel.ts",
  "cli/dev/tui/terminal-renderer.ts",
  "compiler/manifest.ts",
  "harness/tool-loop.ts",
  "internal/nitro/host/create-application-nitro.ts",
  "protocol/message.ts",
  "public/channels/eve.ts",
  "public/channels/auth.ts",
  "public/channels/slack/slackChannel.ts",
  "public/channels/discord/discordChannel.ts",
  "public/channels/teams/teamsChannel.ts",
]);

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);

describe("source file structure", () => {
  it("keeps production source files below the line-count cap", async () => {
    const sourceFiles = await listSourceFiles(SOURCE_ROOT);
    const longFiles: Array<{ file: string; lines: number }> = [];
    const observedLongAllowlist = new Set<string>();

    for (const file of sourceFiles) {
      const content = await readFile(file, "utf8");
      const relPath = toPosix(relative(SOURCE_ROOT, file));
      const lineCount = countLines(content);

      if (lineCount <= MAX_SOURCE_FILE_LINES) continue;

      if (LONG_SOURCE_FILE_ALLOWLIST.has(relPath)) {
        observedLongAllowlist.add(relPath);
      } else {
        longFiles.push({ file: relPath, lines: lineCount });
      }
    }

    const staleAllowlist = [...LONG_SOURCE_FILE_ALLOWLIST].filter(
      (file) => !observedLongAllowlist.has(file),
    );

    if (longFiles.length > 0 || staleAllowlist.length > 0) {
      throw new Error(formatFailure({ longFiles, staleAllowlist }));
    }
  });
});

async function listSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const entries = (await readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;

    const absPath = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(absPath)));
      continue;
    }

    if (entry.isFile() && isProductionSourceFile(entry.name)) {
      files.push(absPath);
    }
  }

  return files;
}

function isProductionSourceFile(fileName: string): boolean {
  if (!/\.(cts|mts|ts|tsx)$/.test(fileName) || fileName.endsWith(".d.ts")) {
    return false;
  }

  return !/\.(test|integration|scenario)\.(cts|mts|ts|tsx)$/.test(fileName);
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function formatFailure({
  longFiles,
  staleAllowlist,
}: {
  longFiles: Array<{ file: string; lines: number }>;
  staleAllowlist: string[];
}): string {
  const sections = [
    `Production source files must stay at or below ${MAX_SOURCE_FILE_LINES} lines.`,
    "Long files are an anti-pattern because they usually mix multiple concerns and are harder for agents to edit safely.",
  ];

  if (longFiles.length > 0) {
    sections.push(
      "",
      "Split each file by concern, or add a temporary allowlist entry only when the file already existed above the cap and the follow-up cleanup is tracked:",
      ...longFiles.map((entry) => `  - ${entry.file}: ${entry.lines} lines`),
    );
  }

  if (staleAllowlist.length > 0) {
    sections.push(
      "",
      "Remove stale allowlist entries for files that no longer exist or are now under the cap:",
      ...staleAllowlist.map((file) => `  - ${file}`),
    );
  }

  return sections.join("\n");
}
