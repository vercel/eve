import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { pathExists } from "#setup/path-exists.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

import { startGitInitialization, tryInitializeGit } from "./init-git.js";

const createScratchDirectory = useTemporaryDirectories();
const runFile = promisify(execFile);

async function withGitIdentity(run: () => Promise<void>): Promise<void> {
  const isolatedConfig = join(await createScratchDirectory("eve-init-git-config-"), "gitconfig");
  await writeFile(isolatedConfig, "[user]\n\tname = eve\n\temail = eve@example.com\n");

  const previousEnv = { ...process.env };
  process.env.GIT_CONFIG_GLOBAL = isolatedConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";

  try {
    await run();
  } finally {
    process.env = previousEnv;
  }
}

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

describe("startGitInitialization", () => {
  it("commits files written after setup started, such as the lockfile", async () => {
    const projectPath = await createScratchDirectory("eve-init-git-split-");
    await writeFile(join(projectPath, "package.json"), "{}\n");

    await withGitIdentity(async () => {
      const git = startGitInitialization(projectPath);
      await git.settled();
      await writeFile(join(projectPath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

      await expect(git.commit()).resolves.toEqual({ kind: "initialized" });
      const { stdout } = await runFile("git", ["ls-files"], { cwd: projectPath });
      expect(stdout.split("\n").filter(Boolean).toSorted()).toEqual([
        "package.json",
        "pnpm-lock.yaml",
      ]);
    });
  });

  it("lets a failed project be removed once setup settles", async () => {
    const projectPath = await createScratchDirectory("eve-init-git-settled-");
    await writeFile(join(projectPath, "package.json"), "{}\n");

    await withGitIdentity(async () => {
      const git = startGitInitialization(projectPath);
      await git.settled();
      await rm(projectPath, { recursive: true });
    });

    await expect(pathExists(projectPath)).resolves.toBe(false);
  });
});

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
