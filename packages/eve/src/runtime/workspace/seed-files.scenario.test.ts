import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { materializeWorkspaceDirectory } from "#runtime/workspace/seed-files.js";
import {
  createSandboxProviderResources,
  providerResourceTargetFiles,
} from "#shared/sandbox-provider.js";

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

    const resources = createSandboxProviderResources({
      key: "resources-hash",
      path: resourceRoot,
      ...(await materializeWorkspaceDirectory(resourceRoot)),
    });

    // Each tree is ordered by locale-aware relative path, not raw bytes.
    expect(resources).toEqual({
      skills: {
        files: [
          { content: Buffer.from("sources"), relativePath: "research/refs/sources.md" },
          { content: Buffer.from("research skill"), relativePath: "research/SKILL.md" },
          { content: Buffer.from("weather skill"), relativePath: "weather/SKILL.md" },
        ],
        key: "resources-hash:skills",
        mountPath: "/eve/resources/skills",
        targetPath: "$HOME/.agents/skills",
      },
      source: { key: "resources-hash", kind: "materialized", path: resourceRoot },
      workspace: {
        files: [
          { content: Buffer.from("a"), relativePath: "data/a.csv" },
          { content: Buffer.from("b"), relativePath: "data/b.csv" },
          { content: Buffer.from("notes"), relativePath: "notes.md" },
          { content: Buffer.from("readme"), relativePath: "README.md" },
        ],
        key: "resources-hash:workspace",
        mountPath: "/eve/resources/workspace",
        targetPath: "/workspace",
      },
    });
    expect(providerResourceTargetFiles(resources).map((file) => file.path)).toEqual([
      "/workspace/data/a.csv",
      "/workspace/data/b.csv",
      "/workspace/notes.md",
      "/workspace/README.md",
      "$HOME/.agents/skills/research/refs/sources.md",
      "$HOME/.agents/skills/research/SKILL.md",
      "$HOME/.agents/skills/weather/SKILL.md",
    ]);
  });
});
