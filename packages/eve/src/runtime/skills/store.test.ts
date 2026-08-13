import { describe, expect, it } from "vitest";

import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import {
  createSandboxSkillStore,
  createSkillStoreLocation,
  resolveSkillStoreModelRoot,
} from "#runtime/skills/store.js";
import { normalizeSkillPackage } from "#shared/skill-package.js";

const HOME_PROBE_COMMAND = `printf '%s\n' "$HOME"`;

describe("sandbox skill store", () => {
  it("chooses the managed root from the agent home", () => {
    const location = createSkillStoreLocation({ home: "/agents/researcher-1c3a9f42" });

    expect(resolveSkillStoreModelRoot(location)).toBe("/agents/researcher-1c3a9f42/.agents/skills");
  });

  it("keeps the home-relative root for the sandbox-owning agent", () => {
    expect(resolveSkillStoreModelRoot(createSkillStoreLocation({}))).toBe("$HOME/.agents/skills");
  });

  it("reads, writes, and removes through the configured store", async () => {
    const sandbox = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
      },
    });
    const store = createSandboxSkillStore(
      sandbox.access,
      createSkillStoreLocation({ home: "/agents/worker-00000000" }),
    );
    const skill = normalizeSkillPackage({
      description: "Research",
      files: { "references/catalog.yml": "entries: []\n" },
      markdown: "# Research\n",
      name: "research",
    });

    await store.write(skill);
    await expect(store.readText("research", "SKILL.md")).resolves.toBe("# Research\n");
    await expect(store.readText("research", "references/catalog.yml")).resolves.toBe(
      "entries: []\n",
    );
    await store.remove("research");
    await expect(store.readText("research", "SKILL.md")).resolves.toBeNull();
  });
});
