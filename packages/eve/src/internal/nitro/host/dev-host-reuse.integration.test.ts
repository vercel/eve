import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  claimReusableDevelopmentHost,
  writeReusableDevelopmentHost,
} from "#internal/nitro/host/dev-host-reuse.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (dir) => await rm(dir, { force: true, recursive: true })),
  );
});

type KeptHost = Awaited<ReturnType<typeof keptHost>>;

async function keptHost(name = "kept") {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-dev-host-reuse-"));
  temporaryDirectories.push(appRoot);
  const rootDir = join(appRoot, ".eve", "dev-hosts", name);
  const entry = join(rootDir, "nitro", "dev", "index.mjs");
  const input = join(appRoot, "node_modules", "dep", "index.js");
  await mkdir(join(rootDir, "nitro", "dev"), { recursive: true });
  await mkdir(join(appRoot, "node_modules", "dep"), { recursive: true });
  await writeFile(entry, "export {};\n");
  await writeFile(input, "export const value = 1;\n");
  const inputStat = await stat(input);
  const record = {
    compiledArtifacts: {
      authoredWorkflowModules: { directiveModules: [], workflowModules: [] },
      bootstrapPath: join(rootDir, "artifacts", "compiled-artifacts-bootstrap.mjs"),
      workflowWorldPluginPath: join(rootDir, "artifacts", "compiled-artifacts-workflow-world.mjs"),
    },
    key: "key-1",
    payload: {
      entry,
      inputs: { [input]: [inputStat.mtimeMs, inputStat.size] as const },
      workerData: {},
    },
    workflowBuildDir: join(rootDir, "workflow"),
    workspace: {
      artifactsDir: join(rootDir, "artifacts"),
      compilerArtifactsDir: join(rootDir, "compiler"),
      nitroBuildDir: join(rootDir, "nitro"),
      nitroOutputDir: join(rootDir, "output"),
      rootDir,
      workflowBuildDir: join(rootDir, "workflow"),
    },
  };
  await writeReusableDevelopmentHost(record, appRoot);
  return { appRoot, entry, input, record, rootDir };
}

describe("claimReusableDevelopmentHost", () => {
  it("hands the kept host to one claimant while its key and build inputs match", async () => {
    const { appRoot, record, rootDir } = await keptHost();

    expect(await claimReusableDevelopmentHost(appRoot, "key-1")).toEqual(record);
    expect(await claimReusableDevelopmentHost(appRoot, "key-1")).toBeUndefined();
    await expect(stat(rootDir)).resolves.toBeDefined();
  });

  it.each([
    ["the key differs", async () => {}, "key-2"],
    [
      "a build input changed",
      async (host: KeptHost) => writeFile(host.input, "export {};\n"),
      "key-1",
    ],
    ["the entry is gone", async (host: KeptHost) => rm(host.entry), "key-1"],
  ] as const)("removes the kept host when %s", async (_case, change, key) => {
    const host = await keptHost();
    await change(host);

    expect(await claimReusableDevelopmentHost(host.appRoot, key)).toBeUndefined();
    await expect(stat(host.rootDir)).rejects.toThrow();
  });
});
