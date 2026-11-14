import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { statBuildInputs } from "#internal/nitro/host/dev-build-operations.js";
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

const claim = async (appRoot: string, key: string | undefined) =>
  await claimReusableDevelopmentHost(appRoot, Promise.resolve(key));

describe("claimReusableDevelopmentHost", () => {
  it("hands the kept host to one claimant while its key and build inputs match", async () => {
    const { appRoot, record, rootDir } = await keptHost();

    expect(await claim(appRoot, "key-1")).toEqual({ kind: "reused", host: record });
    expect(await claim(appRoot, "key-1")).toEqual({ kind: "none" });
    await expect(stat(rootDir)).resolves.toBeDefined();
  });

  it("ignores a record copied from another app, removing only this app's copy", async () => {
    const original = await keptHost();
    const copy = await mkdtemp(join(tmpdir(), "eve-dev-host-reuse-copy-"));
    temporaryDirectories.push(copy);
    const copiedWorkspace = join(copy, ".eve", "dev-hosts", basename(original.rootDir));
    await mkdir(copiedWorkspace, { recursive: true });
    await writeFile(
      join(copy, ".eve", "dev-hosts", "reusable-host.json"),
      await readFile(join(original.appRoot, ".eve", "dev-hosts", "reusable-host.json")),
    );

    expect(await claim(copy, "key-1")).toEqual({
      kind: "rebuilt",
      reason: "it was copied from another app",
    });
    await expect(stat(original.rootDir)).resolves.toBeDefined();
    await expect(stat(copiedWorkspace)).rejects.toThrow();
  });

  it.each([
    [
      "the key differs",
      async () => {},
      "key-2",
      "the agent, its env files, eve, Node, a lockfile, or tsconfig changed",
    ],
    [
      "a build input changed",
      async (host: KeptHost) => writeFile(host.input, "export {};\n"),
      "key-1",
      "a file it was built from changed",
    ],
    [
      "the entry is gone",
      async (host: KeptHost) => rm(host.entry),
      "key-1",
      "its build output is missing",
    ],
    ["reuse is off", async () => {}, undefined, "this eve install is linked or from source"],
  ] as const)("removes the kept host when %s", async (_case, change, key, reason) => {
    const host = await keptHost();
    await change(host);

    expect(await claim(host.appRoot, key)).toEqual({ kind: "rebuilt", reason });
    await expect(stat(host.rootDir)).rejects.toThrow();
  });
});

describe("writeReusableDevelopmentHost", () => {
  it("leaves a host that a starting server claimed first", async () => {
    const first = await keptHost("first");
    expect(await claim(first.appRoot, "key-1")).toEqual({ kind: "reused", host: first.record });
    const rootDir = join(first.appRoot, ".eve", "dev-hosts", "second");
    await mkdir(rootDir, { recursive: true });

    await writeReusableDevelopmentHost(
      {
        ...first.record,
        workspace: { ...first.record.workspace, rootDir },
        payload: { ...first.record.payload, entry: join(rootDir, "index.mjs") },
      },
      first.appRoot,
    );

    await expect(stat(first.rootDir)).resolves.toBeDefined();
  });

  it("removes the host it replaces", async () => {
    const first = await keptHost("first");
    const rootDir = join(first.appRoot, ".eve", "dev-hosts", "second");
    await mkdir(rootDir, { recursive: true });

    await writeReusableDevelopmentHost(
      {
        ...first.record,
        workspace: { ...first.record.workspace, rootDir },
        payload: { ...first.record.payload, entry: join(rootDir, "index.mjs") },
      },
      first.appRoot,
    );

    await expect(stat(first.rootDir)).rejects.toThrow();
    await expect(stat(rootDir)).resolves.toBeDefined();
  });
});

describe("statBuildInputs", () => {
  it("records inputs from outside the workspace that predate the build", async () => {
    const { input, rootDir } = await keptHost();
    const generated = join(rootDir, "workflow", "steps.mjs");
    await mkdir(join(rootDir, "workflow"), { recursive: true });
    await writeFile(generated, "export {};\n");
    await utimes(input, new Date(1_000), new Date(1_000));

    const inputs = await statBuildInputs([input, `${input}?raw`, generated], rootDir, Date.now());

    expect(inputs).toEqual({ [input]: [1_000, (await stat(input)).size] });
  });

  it("records nothing when an input changed after the build started", async () => {
    const { input, rootDir } = await keptHost();
    const buildStartedAt = Date.now() - 1_000;

    expect(await statBuildInputs([input], rootDir, buildStartedAt)).toBeUndefined();
  });
});
