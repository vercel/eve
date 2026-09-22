import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensurePackageDependencies } from "./dependencies.js";

const roots: string[] = [];

async function project(packageJson: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eve-dependencies-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("ensurePackageDependencies", () => {
  it("adds only missing or outdated runtime dependencies", async () => {
    const root = await project({
      dependencies: { "@vercel/connect": "2.2.0", existing: "1.0.0" },
    });

    await expect(
      ensurePackageDependencies({
        dependencies: { "@vercel/connect": "2.2.0", microsandbox: "0.5.5" },
        projectRoot: root,
      }),
    ).resolves.toEqual([
      {
        dependencies: ["microsandbox"],
        devDependencies: [],
        path: join(root, "package.json"),
        scripts: [],
      },
    ]);
    await expect(readFile(join(root, "package.json"), "utf8")).resolves.toContain(
      '"microsandbox": "0.5.5"',
    );
  });

  it("does not report a mutation when dependencies already match", async () => {
    const root = await project({ dependencies: { microsandbox: "0.5.5" } });

    await expect(
      ensurePackageDependencies({
        dependencies: { microsandbox: "0.5.5" },
        projectRoot: root,
      }),
    ).resolves.toEqual([]);
  });
});
