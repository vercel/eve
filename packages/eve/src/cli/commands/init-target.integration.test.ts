import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

import { resolveInitTarget } from "./init-target.js";

const createScratchDirectory = useTemporaryDirectories();

function resolveTarget(parentDirectory: string, target?: string) {
  return resolveInitTarget({ parentDirectory, target });
}

describe("resolveInitTarget", () => {
  it("treats nested and absolute targets as filesystem paths", async () => {
    const parentDirectory = await createScratchDirectory("eve-init-target-path-");
    const nested = join(parentDirectory, "apps", "weather");

    await expect(resolveTarget(parentDirectory, "apps/weather")).resolves.toMatchObject({
      kind: "fresh",
      projectName: "weather",
      projectPath: nested,
    });
    await expect(resolveTarget(parentDirectory, nested)).resolves.toMatchObject({
      kind: "fresh",
      projectName: "weather",
      projectPath: nested,
    });
  });

  it("rejects targets that traverse outside the parent directory", async () => {
    const parentDirectory = await createScratchDirectory("eve-init-target-parent-");

    await expect(resolveTarget(parentDirectory, "../escaped")).rejects.toThrow(
      "Project name can only contain",
    );
    await expect(resolveTarget(parentDirectory, "apps/../escaped")).resolves.toMatchObject({
      kind: "fresh",
      projectPath: join(parentDirectory, "escaped"),
    });
  });

  it("preserves the small environment-only allowlist", async () => {
    const parentDirectory = await createScratchDirectory("eve-init-target-environment-");
    const projectPath = join(parentDirectory, "weather");
    await mkdir(projectPath);
    await mkdir(join(projectPath, ".git"));
    await mkdir(join(projectPath, ".vscode"));
    await writeFile(join(projectPath, ".gitignore"), "node_modules\n");

    await expect(resolveTarget(projectPath, ".")).resolves.toMatchObject({
      kind: "fresh",
      overwriteExisting: false,
      preservedEntries: [".git", ".gitignore", ".vscode"],
      projectPath,
    });
  });

  it.each([undefined, ".", "./", "nested/../."] as const)(
    "adds to an existing package when target is %j",
    async (target) => {
      const projectPath = await createScratchDirectory("eve-init-target-package-");
      await writeFile(join(projectPath, "package.json"), "{}\n");

      await expect(resolveTarget(projectPath, target)).resolves.toEqual({
        kind: "existing",
        projectPath,
      });
    },
  );

  it("adds to an existing package addressed by a relative path", async () => {
    const parentDirectory = await createScratchDirectory("eve-init-target-parent-package-");
    const projectPath = join(parentDirectory, "existing-app");
    await mkdir(projectPath);
    await writeFile(join(projectPath, "package.json"), "{}\n");

    await expect(resolveTarget(parentDirectory, "existing-app")).resolves.toEqual({
      kind: "existing",
      projectPath,
    });
  });

  it("stops when the target is already an eve project", async () => {
    const projectPath = await createScratchDirectory("eve-init-target-eve-");
    await mkdir(join(projectPath, "agent"));
    await writeFile(join(projectPath, "agent", "instructions.md"), "You are helpful.\n");
    await writeFile(join(projectPath, "package.json"), "{}\n");

    await expect(resolveTarget(projectPath, ".")).rejects.toThrow("An eve project already exists");
  });

  it("stops when a path target is an eve agent workspace", async () => {
    const parentDirectory = await createScratchDirectory("eve-init-target-workspace-parent-");
    const projectPath = join(parentDirectory, "workspace");
    await mkdir(join(projectPath, "agents", "support", "agent"), { recursive: true });
    await writeFile(join(projectPath, "agents", "support", "agent", "agent.ts"), "export {};\n");
    await writeFile(join(projectPath, "package.json"), "{}\n");

    await expect(resolveTarget(parentDirectory, "workspace")).rejects.toThrow(
      "An eve project already exists",
    );
  });

  it("lists arbitrary content instead of guessing how to integrate it", async () => {
    const projectPath = await createScratchDirectory("eve-init-target-content-");
    await writeFile(join(projectPath, "README.md"), "# Existing\n");
    await writeFile(join(projectPath, ".unknown"), "value\n");

    await expect(resolveTarget(projectPath, ".")).rejects.toThrow("  - .unknown\n  - README.md");
  });
});
