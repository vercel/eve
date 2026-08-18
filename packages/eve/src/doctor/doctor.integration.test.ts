import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

import { runLocalDoctor } from "./doctor.js";

const createScratchDirectory = useTemporaryDirectories();

afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
});

describe("runLocalDoctor", () => {
  it("collects independent local results without requiring Git or network", async () => {
    const appRoot = await createScratchDirectory("eve-doctor-");
    await mkdir(join(appRoot, "agent"));
    await writeFile(join(appRoot, "agent", "instructions.md"), "You are helpful.\n");
    await writeFile(
      join(appRoot, "package.json"),
      `${JSON.stringify({ dependencies: { eve: "latest" }, packageManager: "pnpm@11" })}\n`,
    );
    await writeFile(join(appRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(join(appRoot, "package-lock.json"), "{}\n");

    const result = await runLocalDoctor(join(appRoot, "agent"));

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "project.discovery", status: "pass" }),
        expect.objectContaining({ id: "package.manager", status: "warn" }),
        expect.objectContaining({ id: "package.dependencies", status: "fail" }),
        expect.objectContaining({ id: "git.repository", status: "warn" }),
      ]),
    );
  });

  it("reports unavailable Git tooling instead of a missing repository", async () => {
    const appRoot = await createScratchDirectory("eve-doctor-no-git-");
    await mkdir(join(appRoot, "agent"));
    await writeFile(join(appRoot, "agent", "instructions.md"), "You are helpful.\n");
    await writeFile(join(appRoot, "package.json"), '{ "packageManager": "pnpm@11" }\n');
    vi.stubEnv("PATH", "");

    const result = await runLocalDoctor(appRoot);

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "git.repository", status: "unknown" }),
        expect.objectContaining({ id: "git.remote", status: "unknown" }),
      ]),
    );
  });

  it("continues rendering Node facts when discovery fails", async () => {
    const path = await createScratchDirectory("eve-doctor-empty-");
    const result = await runLocalDoctor(path);

    expect(result.diagnostics.map((diagnostic) => diagnostic.id)).toEqual([
      "runtime.node",
      "project.discovery",
    ]);
    expect(result.summary.fail).toBeGreaterThan(0);
  });
});
