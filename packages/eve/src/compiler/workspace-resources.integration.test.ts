import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compiledAgentManifestSchema, createCompiledAgentManifest } from "#compiler/manifest.js";
import { materializeWorkspaceResources } from "#compiler/workspace-resources.js";
import { classifyModelRouting } from "#internal/classify-model-routing.js";
import { normalizeSkillPackage } from "#shared/skill-package.js";

describe("materializeWorkspaceResources", () => {
  it("retains immutable authored package identity after stripping source bytes", async () => {
    const compileDirectoryPath = await mkdtemp(join(tmpdir(), "eve-workspace-resources-"));
    const skill = {
      description: "Research deeply",
      files: { "references/method.md": "Check primary sources." },
      logicalPath: "skills/research.ts",
      markdown: "# Research\n",
      name: "research",
      sourceId: "skills/research.ts",
      sourceKind: "module" as const,
    };

    try {
      const compiled = await materializeWorkspaceResources({
        compileDirectoryPath,
        manifest: createCompiledAgentManifest({
          agentRoot: "/app/agent",
          appRoot: "/app",
          config: {
            model: { id: "test", routing: classifyModelRouting("test") },
            name: "app",
          },
          skills: [skill],
        }),
      });
      const parsed = compiledAgentManifestSchema.parse(compiled);
      const expected = normalizeSkillPackage(skill);

      expect(parsed.skills[0]).toMatchObject({
        contentDigest: expected.contentDigest,
        relativePaths: expected.files.map((file) => file.relativePath),
      });
      expect(parsed.skills[0]).not.toHaveProperty("files");
    } finally {
      await rm(compileDirectoryPath, { force: true, recursive: true });
    }
  });
});
