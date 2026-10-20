import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEvalStateDirectory } from "#evals/cli/eval-state-directory.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function writeRunDirectory(appRoot: string, runId: string, owner?: unknown) {
  const directory = join(appRoot, ".eve", "eval-servers", runId);
  await mkdir(join(directory, "dev-runtime"), { recursive: true });
  if (owner !== undefined) {
    await writeFile(join(directory, "owner.json"), JSON.stringify(owner));
  }
  return directory;
}

describe("createEvalStateDirectory", () => {
  it("removes directories of dead eval runs and keeps live or still-starting ones", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-eval-state-"));
    temporaryRoots.push(appRoot);
    // Above every platform's pid range, so no process can own it.
    const abandoned = await writeRunDirectory(appRoot, "abandoned", { pid: 2_147_483_646 });
    const live = await writeRunDirectory(appRoot, "live", { pid: process.pid });
    const starting = await writeRunDirectory(appRoot, "starting");

    const directory = await createEvalStateDirectory(appRoot, "current");

    expect(directory).toBe(join(appRoot, ".eve", "eval-servers", "current"));
    await expect(access(join(directory, "owner.json"))).resolves.toBeUndefined();
    await expect(access(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(live)).resolves.toBeUndefined();
    await expect(access(starting)).resolves.toBeUndefined();
  });
});
