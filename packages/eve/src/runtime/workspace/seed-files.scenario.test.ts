import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { materializeWorkspaceDirectory } from "#runtime/workspace/seed-files.js";
import { createSandboxPrepareContext } from "#execution/sandbox/prewarm.js";
import { populatedPaths } from "#internal/testing/sandbox-provider-harness.js";

const createScratchDirectory = useTemporaryDirectories();

describe("compiled resource root materialization", () => {
  it("hands providers separate workspace and skill trees with stable target paths", async () => {
    const resourceRoot = await createScratchDirectory("eve-resource-root-");
    const files: Record<string, string> = {
      "skills/research/SKILL.md": "research skill",
      "skills/research/refs/sources.md": "sources",
      "skills/weather/SKILL.md": "weather skill",
      "workspace/README.md": "readme",
      "workspace/data/a.csv": "a",
      "workspace/data/b.csv": "b",
      "workspace/notes.md": "notes",
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(resourceRoot, path)), { recursive: true });
      await writeFile(join(resourceRoot, path), content);
    }

    const trees = await materializeWorkspaceDirectory(resourceRoot);

    // Each tree is ordered by locale-aware relative path, not raw bytes.
    expect(trees).toEqual({
      skills: [
        { content: Buffer.from("sources"), relativePath: "research/refs/sources.md" },
        { content: Buffer.from("research skill"), relativePath: "research/SKILL.md" },
        { content: Buffer.from("weather skill"), relativePath: "weather/SKILL.md" },
      ],
      workspace: [
        { content: Buffer.from("a"), relativePath: "data/a.csv" },
        { content: Buffer.from("b"), relativePath: "data/b.csv" },
        { content: Buffer.from("notes"), relativePath: "notes.md" },
        { content: Buffer.from("readme"), relativePath: "README.md" },
      ],
    });
    const context = createSandboxPrepareContext({
      appRoot: resourceRoot,
      files: { list: async () => [], read: async () => new Uint8Array(), readText: async () => "" },
      log: () => {},
      provider: { prepare: undefined, providerName: "test" },
      resources: { key: "resources-hash", path: resourceRoot, ...trees },
      sourceRevision: "revision",
      storagePath: resourceRoot,
    });
    expect(await populatedPaths(context)).toEqual([
      "/workspace/data/a.csv",
      "/workspace/data/b.csv",
      "/workspace/notes.md",
      "/workspace/README.md",
      "/home/agent/.agents/skills/research/refs/sources.md",
      "/home/agent/.agents/skills/research/SKILL.md",
      "/home/agent/.agents/skills/weather/SKILL.md",
    ]);
  });
});
