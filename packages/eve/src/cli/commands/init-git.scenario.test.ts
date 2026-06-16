import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { pathExists } from "#setup/path-exists.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

import { tryInitializeGit } from "./init-git.js";

const createScratchDirectory = useTemporaryDirectories();

describe("tryInitializeGit", () => {
  it("removes a partial repository when the initial commit fails", async () => {
    const projectPath = await createScratchDirectory("eve-init-git-failure-");
    const isolatedConfig = join(projectPath, "gitconfig");
    await writeFile(join(projectPath, "package.json"), "{}\n");
    await writeFile(isolatedConfig, "");

    const previousEnv = { ...process.env };
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "user.useConfigOnly";
    process.env.GIT_CONFIG_VALUE_0 = "true";
    process.env.GIT_CONFIG_GLOBAL = isolatedConfig;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.HOME = join(tmpdir(), "eve-init-no-git-identity");
    delete process.env.EMAIL;
    delete process.env.GIT_AUTHOR_EMAIL;
    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_COMMITTER_EMAIL;
    delete process.env.GIT_COMMITTER_NAME;

    try {
      expect(tryInitializeGit(projectPath)).toMatchObject({ kind: "failed" });
      await expect(pathExists(join(projectPath, ".git"))).resolves.toBe(false);
    } finally {
      process.env = previousEnv;
    }
  });
});
