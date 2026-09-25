import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { pathExists } from "#setup/path-exists.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

import { tryInitializeGit } from "./init-git.js";

const createScratchDirectory = useTemporaryDirectories();

async function withoutGitIdentity(projectPath: string, run: () => Promise<void>): Promise<void> {
  const isolatedConfig = join(projectPath, "gitconfig");
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
    await run();
  } finally {
    process.env = previousEnv;
  }
}

describe("tryInitializeGit", () => {
  it("retains an initialized repository when the initial commit fails", async () => {
    const projectPath = await createScratchDirectory("eve-init-git-failure-");
    await writeFile(join(projectPath, "package.json"), "{}\n");

    await withoutGitIdentity(projectPath, async () => {
      await expect(tryInitializeGit(projectPath)).resolves.toMatchObject({
        kind: "failed",
        repositoryInitialized: true,
        stage: "commit",
      });
      await expect(pathExists(join(projectPath, ".git"))).resolves.toBe(true);
    });
  });

  it("skips initialization when Git metadata already exists", async () => {
    const projectPath = await createScratchDirectory("eve-init-existing-git-");
    const gitPath = join(projectPath, ".git");
    await mkdir(gitPath);
    await writeFile(join(gitPath, "keep"), "preexisting\n");
    await writeFile(join(projectPath, "package.json"), "{}\n");

    await expect(tryInitializeGit(projectPath)).resolves.toEqual({
      kind: "skipped",
      reason: "existing-metadata",
    });
    await expect(readdir(gitPath)).resolves.toEqual(["keep"]);
    await expect(readFile(join(gitPath, "keep"), "utf8")).resolves.toBe("preexisting\n");
  });
});
