import { readlink, symlink } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAgent } from "#compiler/compile-agent.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";

const createAppRoot = useTemporaryAppRoots();

describe("materializeWorkspaceResources", () => {
  it("keeps nested relative symlinks in workspace files and skill packages relative", async () => {
    const app = await createAppRoot("eve-workspace-resource-symlinks-", {
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };',
        "agent/instructions.md": "Help with notes.",
        "agent/sandbox/workspace/data/notes.txt": "seed",
        "agent/skills/review/SKILL.md": [
          "---",
          "description: Review notes.",
          "---",
          "Read the guide before reviewing.",
        ].join("\n"),
        "agent/skills/review/references/guide.md": "guide",
      },
    });
    await symlink("notes.txt", join(app.agentRoot, "sandbox/workspace/data/current.txt"));
    await symlink("guide.md", join(app.agentRoot, "skills/review/references/latest.md"));

    const { paths } = await compileAgent({ startPath: app.appRoot });
    const manifest = await loadCompiledManifest({
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(app.appRoot),
    });
    const resourceRoot = join(
      paths.compileDirectoryPath,
      manifest.workspaceResourceRoot.logicalPath,
    );

    expect(await readlink(join(resourceRoot, "workspace/data/current.txt"))).toBe("notes.txt");
    expect(await readlink(join(resourceRoot, "skills/review/references/latest.md"))).toBe(
      "guide.md",
    );
  });
});
