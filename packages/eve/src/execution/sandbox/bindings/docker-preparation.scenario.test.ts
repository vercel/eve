import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { createDockerSandboxProvider } from "#execution/sandbox/bindings/docker.js";
import { createFakeDockerCli } from "#internal/testing/fake-docker-cli.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import type { SandboxPrepareContext } from "#public/sandbox/provider.js";

const createScratchDirectory = useTemporaryDirectories();
afterEach(() => vi.useRealTimers());

async function createContext(
  templateKey: string,
  populate: SandboxPrepareContext["populate"] = async () => {},
): Promise<SandboxPrepareContext> {
  const storagePath = await createScratchDirectory("eve-docker-preparation-");
  const missingFile = async (): Promise<never> => {
    throw Object.assign(new Error("No such file"), { code: "ENOENT" });
  };
  return {
    files: { list: async () => [], read: missingFile, readText: missingFile },
    isEmpty: false,
    log() {},
    populate,
    resolveProjectPath: (path) => join(storagePath, path),
    resourcesDirectory: async () => undefined,
    storagePath,
    templateKey: () => templateKey,
  };
}

async function expectMarker(context: SandboxPrepareContext, imageReference: string) {
  const tag = imageReference.slice(imageReference.indexOf(":") + 1);
  await expect(
    readFile(join(context.storagePath, "docker", "templates", tag), "utf8"),
  ).resolves.toBe(`${imageReference}\n`);
}

it("shares preparation across providers, records every app, and lets other images progress", async () => {
  const images = new Set<string>();
  const { calls, cli } = createFakeDockerCli((args) => {
    const reference = args.at(-1)!;
    if (
      args[0] === "image" &&
      args[1] === "inspect" &&
      reference.startsWith("eve-sandbox-template:")
    )
      return images.has(reference) ? undefined : { exitCode: 1, stderr: "No such image" };
    if (args[0] === "commit") images.add(reference);
    return undefined;
  });
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const populate = vi.fn(async () => {
    started.resolve();
    await release.promise;
  });
  const alice = await createContext("shared-template", populate);
  const bob = await createContext("shared-template", populate);
  const charlie = await createContext("independent-template");
  const first = createDockerSandboxProvider({}, cli).prepare(alice);
  const second = createDockerSandboxProvider({}, cli).prepare(bob);
  await started.promise;
  let independent: { imageReference: string };
  try {
    independent = await createDockerSandboxProvider({}, cli).prepare(charlie);
  } finally {
    release.resolve();
  }
  const [a, b] = await Promise.all([first, second]);

  expect(a).toEqual(b);
  expect(independent.imageReference).not.toBe(a.imageReference);
  expect(populate).toHaveBeenCalledTimes(1);
  expect(calls.filter(({ args }) => args[0] === "commit")).toHaveLength(2);
  await expectMarker(alice, a.imageReference);
  await expectMarker(bob, b.imageReference);
  await expectMarker(charlie, independent.imageReference);

  images.delete(a.imageReference);
  await createDockerSandboxProvider({}, cli).prepare(alice);
  expect(populate).toHaveBeenCalledTimes(2);
});

it("shares a genuine failure and permits a later preparation to retry", async () => {
  let commits = 0;
  const { calls, cli } = createFakeDockerCli((args) => {
    if (args[0] === "image" && args[1] === "inspect")
      return { exitCode: 1, stderr: "No such image" };
    if (args[0] === "commit" && ++commits === 1) return { exitCode: 1, stderr: "disk full" };
    return undefined;
  });
  const alice = await createContext("retry-template");
  const bob = await createContext("retry-template");
  const provider = createDockerSandboxProvider({}, cli);
  const results = await Promise.allSettled([
    provider.prepare(alice),
    createDockerSandboxProvider({}, cli).prepare(bob),
  ]);
  for (const result of results) {
    expect(result).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringMatching(/Failed to commit sandbox template image .*: disk full/u),
      }),
    });
  }
  expect(commits).toBe(1);

  const artifact = await provider.prepare(alice);
  expect(commits).toBe(2);
  expect(calls.filter(({ args }) => args[0] === "rm")).toHaveLength(2);
  await expectMarker(alice, artifact.imageReference);
});

it("reuses a peer image after Docker briefly reports it missing following AlreadyExists", async () => {
  const context = await createContext("peer-template");
  vi.useFakeTimers();
  const committed = Promise.withResolvers<void>();
  let publishedReference: string | undefined;
  let visibilityMisses = 3;
  const { calls, cli } = createFakeDockerCli((args) => {
    if (args[0] === "image" && args[1] === "inspect") {
      return publishedReference === args.at(-1) && visibilityMisses-- <= 0
        ? { stdout: "sha256:peer\n" }
        : { exitCode: 1, stderr: "No such image" };
    }
    if (args[0] === "commit") {
      publishedReference = args.at(-1);
      committed.resolve();
      return { exitCode: 1, stderr: `AlreadyExists: image "${publishedReference}" already exists` };
    }
    return undefined;
  });
  const result = createDockerSandboxProvider({}, cli)
    .prepare(context)
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  await committed.promise;
  await vi.runAllTimersAsync();

  expect(await result).toEqual({ value: { imageReference: publishedReference } });
  expect(calls.filter(({ args }) => args[0] === "commit")).toHaveLength(1);
  expect(calls.filter(({ args }) => args[0] === "rm")).toHaveLength(1);
  await expectMarker(context, publishedReference!);
});

it("stops waiting for an invisible peer image and preserves the original commit error", async () => {
  const context = await createContext("invisible-peer-template");
  vi.useFakeTimers();
  const committed = Promise.withResolvers<void>();
  const { calls, cli } = createFakeDockerCli((args) => {
    if (args[0] === "image" && args[1] === "inspect")
      return { exitCode: 1, stderr: "No such image" };
    if (args[0] === "commit") {
      committed.resolve();
      return { exitCode: 1, stderr: "AlreadyExists: peer image is not yet visible" };
    }
    return undefined;
  });
  const result = createDockerSandboxProvider({}, cli)
    .prepare(context)
    .catch((error: unknown) => error);
  await committed.promise;
  await vi.runAllTimersAsync();

  expect(await result).toMatchObject({
    message: expect.stringMatching(
      /Failed to commit sandbox template image .*: AlreadyExists: peer image is not yet visible/u,
    ),
  });
  expect(vi.getTimerCount()).toBe(0);
  expect(calls.filter(({ args }) => args[0] === "rm")).toHaveLength(1);
});
