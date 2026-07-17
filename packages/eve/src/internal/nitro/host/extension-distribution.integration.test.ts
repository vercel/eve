import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ExtensionOutputRestoreError,
  replaceExtensionBuildOutput,
} from "#internal/nitro/host/extension-distribution.js";

const failRenamesFrom = new Set<string>();
const failRenamesTo = new Set<string>();

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (failRenamesFrom.has(String(from)) || failRenamesTo.has(String(to))) {
        throw Object.assign(new Error("EACCES: simulated rename failure"), { code: "EACCES" });
      }
      return actual.rename(from, to);
    },
  };
});

async function createPublishFixture(): Promise<{
  outDir: string;
  stagedOutDir: string;
  transactionRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "eve-ext-publish-"));
  const transactionRoot = join(root, ".eve-extension-build-txn");
  const stagedOutDir = join(transactionRoot, "output");
  await mkdir(stagedOutDir, { recursive: true });
  await writeFile(join(stagedOutDir, "index.mjs"), "export const build = 2;\n", "utf8");
  return { outDir: join(root, "dist"), stagedOutDir, transactionRoot };
}

describe("replaceExtensionBuildOutput", () => {
  beforeEach(() => {
    failRenamesFrom.clear();
    failRenamesTo.clear();
  });

  it("publishes into a nested output directory whose parent does not exist yet", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-ext-nested-"));
    const transactionRoot = join(root, ".txn");
    const stagedOutDir = join(transactionRoot, "output");
    await mkdir(stagedOutDir, { recursive: true });
    await writeFile(join(stagedOutDir, "index.mjs"), "export {};\n", "utf8");

    const outDir = join(root, "build", "gen");
    await replaceExtensionBuildOutput({ outDir, stagedOutDir, transactionRoot });

    await expect(readFile(join(outDir, "index.mjs"), "utf8")).resolves.toBe("export {};\n");
  });

  it("restores the previous output when publishing fails", async () => {
    const { outDir, stagedOutDir, transactionRoot } = await createPublishFixture();
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "index.mjs"), "export const build = 1;\n", "utf8");
    failRenamesFrom.add(stagedOutDir);

    await expect(
      replaceExtensionBuildOutput({ outDir, stagedOutDir, transactionRoot }),
    ).rejects.toThrow(/simulated rename failure/);

    await expect(readFile(join(outDir, "index.mjs"), "utf8")).resolves.toBe(
      "export const build = 1;\n",
    );
  });

  it("preserves the prior output when publishing and restoring both fail", async () => {
    const { outDir, stagedOutDir, transactionRoot } = await createPublishFixture();
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "index.mjs"), "export const build = 1;\n", "utf8");
    failRenamesTo.add(outDir);

    let error: unknown;
    try {
      await replaceExtensionBuildOutput({ outDir, stagedOutDir, transactionRoot });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ExtensionOutputRestoreError);
    const restoreError = error as ExtensionOutputRestoreError;
    expect(restoreError.preservedOutputPath).toBe(join(transactionRoot, "previous-output"));
    await expect(
      readFile(join(restoreError.preservedOutputPath, "index.mjs"), "utf8"),
    ).resolves.toBe("export const build = 1;\n");
  });
});
