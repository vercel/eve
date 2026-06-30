import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { mergeAuthoredVercelGitConfigIntoBuildOutput } from "./authored-vercel-config.js";

const temporaryRoots: string[] = [];

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function writeOutputConfig(
  outputDir: string,
  config: Record<string, unknown> = { routes: [{ handle: "filesystem" }], version: 3 },
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

async function readOutputConfig(outputDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(outputDir, "config.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("mergeAuthoredVercelGitConfigIntoBuildOutput", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map(async (root) => {
        await rm(root, { force: true, recursive: true });
      }),
    );
  });

  it("preserves git deployment policy from vercel.json", async () => {
    const appRoot = await createTempRoot("eve-authored-vercel-json-");
    const outputDir = join(appRoot, ".vercel", "output");

    await writeFile(
      join(appRoot, "vercel.json"),
      `${JSON.stringify({ git: { deploymentEnabled: { "*": false, master: true } } }, null, 2)}\n`,
    );
    await writeOutputConfig(outputDir);

    await mergeAuthoredVercelGitConfigIntoBuildOutput({ appRoot, outputDir });

    await expect(readOutputConfig(outputDir)).resolves.toEqual({
      git: {
        deploymentEnabled: {
          "*": false,
          master: true,
        },
      },
      routes: [{ handle: "filesystem" }],
      version: 3,
    });
  });

  it("preserves git deployment policy from vercel.ts", async () => {
    const appRoot = await createTempRoot("eve-authored-vercel-ts-");
    const outputDir = join(appRoot, ".vercel", "output");

    await writeFile(
      join(appRoot, "vercel.ts"),
      [
        'import type { VercelConfig } from "@vercel/config/v1";',
        "export const config: VercelConfig = {",
        "  git: {",
        '    deploymentEnabled: { "*": false, master: true },',
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    await writeOutputConfig(outputDir);

    await mergeAuthoredVercelGitConfigIntoBuildOutput({ appRoot, outputDir });

    await expect(readOutputConfig(outputDir)).resolves.toMatchObject({
      git: {
        deploymentEnabled: {
          "*": false,
          master: true,
        },
      },
    });
  });

  it("does not replace git config already emitted in Build Output", async () => {
    const appRoot = await createTempRoot("eve-authored-vercel-existing-");
    const outputDir = join(appRoot, ".vercel", "output");

    await writeFile(
      join(appRoot, "vercel.json"),
      `${JSON.stringify({ git: { deploymentEnabled: { "*": false } } }, null, 2)}\n`,
    );
    await writeOutputConfig(outputDir, {
      git: { deploymentEnabled: { main: true } },
      version: 3,
    });

    await mergeAuthoredVercelGitConfigIntoBuildOutput({ appRoot, outputDir });

    await expect(readOutputConfig(outputDir)).resolves.toEqual({
      git: { deploymentEnabled: { main: true } },
      version: 3,
    });
  });
});
