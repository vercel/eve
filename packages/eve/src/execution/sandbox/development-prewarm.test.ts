import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  startDevelopmentSandboxPrewarmInBackground,
  subscribeDevelopmentSandboxPrewarmLogs,
  waitForDevelopmentSandboxPrewarm,
} from "#execution/sandbox/development-prewarm.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

const mocks = vi.hoisted(() => ({
  prewarmAppSandboxes:
    vi.fn<
      (input: {
        readonly log?: (message: string) => void;
        readonly onPrewarmSignature?: (signature: string) => void;
        readonly shouldPrewarmSignature?: (signature: string) => boolean;
      }) => Promise<void>
    >(),
}));

vi.mock("#execution/sandbox/prewarm.js", () => ({
  prewarmAppSandboxes: mocks.prewarmAppSandboxes,
}));

describe("development sandbox prewarm coordination", () => {
  beforeEach(() => {
    mocks.prewarmAppSandboxes.mockReset();
  });

  it("waits for an in-flight prewarm by authored app root or compiled snapshot root", async () => {
    const prewarm = createDeferred<void>();
    mocks.prewarmAppSandboxes.mockReturnValueOnce(prewarm.promise);
    const appRoot = "/tmp/eve-app";
    const snapshotRoot = "/tmp/eve-app/.eve/dev-runtime/snapshots/current";
    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(snapshotRoot);

    startDevelopmentSandboxPrewarmInBackground({
      appRoot,
      compiledArtifactsSource,
    });

    let authoredWaitResolved = false;
    let snapshotWaitResolved = false;
    const authoredWait = waitForDevelopmentSandboxPrewarm({
      appRoot,
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot),
    }).then(() => {
      authoredWaitResolved = true;
    });
    const snapshotWait = waitForDevelopmentSandboxPrewarm({
      appRoot: snapshotRoot,
      compiledArtifactsSource,
    }).then(() => {
      snapshotWaitResolved = true;
    });

    await Promise.resolve();
    expect(authoredWaitResolved).toBe(false);
    expect(snapshotWaitResolved).toBe(false);

    prewarm.resolve();
    await Promise.all([authoredWait, snapshotWait]);

    expect(authoredWaitResolved).toBe(true);
    expect(snapshotWaitResolved).toBe(true);
  });

  it("waits for an in-flight prewarm by the stable sandbox app root", async () => {
    const prewarm = createDeferred<void>();
    mocks.prewarmAppSandboxes.mockReturnValueOnce(prewarm.promise);
    const appRoot = "/tmp/eve-app";
    const snapshotRoot = "/tmp/eve-app/.eve/dev-runtime/snapshots/current/app";
    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(snapshotRoot, {
      moduleMapLoaderPath: "/tmp/eve-package/authored-module-map-loader.ts",
      sandboxAppRoot: appRoot,
    });

    startDevelopmentSandboxPrewarmInBackground({
      appRoot: snapshotRoot,
      compiledArtifactsSource,
    });

    let sandboxRootWaitResolved = false;
    const sandboxRootWait = waitForDevelopmentSandboxPrewarm({
      appRoot,
      compiledArtifactsSource,
    }).then(() => {
      sandboxRootWaitResolved = true;
    });

    await Promise.resolve();
    expect(sandboxRootWaitResolved).toBe(false);

    prewarm.resolve();
    await sandboxRootWait;

    expect(sandboxRootWaitResolved).toBe(true);
  });

  it("replays and forwards prewarm progress logs to waiters", async () => {
    const prewarm = createDeferred<void>();
    let prewarmLog: ((message: string) => void) | undefined;
    mocks.prewarmAppSandboxes.mockImplementationOnce(async (input) => {
      prewarmLog = input.log;
      return await prewarm.promise;
    });
    const appRoot = "/tmp/eve-app";
    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);

    startDevelopmentSandboxPrewarmInBackground({
      appRoot,
      compiledArtifactsSource,
    });
    prewarmLog?.('eve: sandbox template "root" (microsandbox): preparing base runtime inside VM');

    const logs: string[] = [];
    const wait = waitForDevelopmentSandboxPrewarm({
      appRoot,
      compiledArtifactsSource,
      log: (message) => logs.push(message),
    });
    await Promise.resolve();
    prewarmLog?.('eve: sandbox template "root" (microsandbox): apt-get update');

    prewarm.resolve();
    await wait;

    expect(logs).toEqual(
      expect.arrayContaining([
        'eve: sandbox template "root" (microsandbox): preparing base runtime inside VM',
        'eve: sandbox template "root" (microsandbox): apt-get update',
      ]),
    );
  });

  it("replays retained logs and forwards future logs to subscribers", async () => {
    const prewarm = createDeferred<void>();
    let prewarmLog: ((message: string) => void) | undefined;
    mocks.prewarmAppSandboxes.mockImplementationOnce(async (input) => {
      prewarmLog = input.log;
      return await prewarm.promise;
    });
    const appRoot = "/tmp/eve-app";
    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);

    startDevelopmentSandboxPrewarmInBackground({
      appRoot,
      compiledArtifactsSource,
    });
    prewarmLog?.('eve: built sandbox template "root" on backend "docker".');

    const logs: string[] = [];
    const unsubscribe = subscribeDevelopmentSandboxPrewarmLogs({
      appRoot,
      log: (message) => logs.push(message),
    });
    prewarmLog?.('eve: sandbox template "root" (docker): apt-get update');

    unsubscribe();
    prewarmLog?.('eve: sandbox template "root" (docker): apt-get install curl');
    prewarm.resolve();
    await prewarm.promise;

    expect(logs).toEqual([
      'eve: built sandbox template "root" on backend "docker".',
      'eve: sandbox template "root" (docker): apt-get update',
    ]);
  });

  it("keeps completed background prewarm logs for one TUI subscription", async () => {
    const appRoot = "/tmp/eve-completed-app";
    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);
    mocks.prewarmAppSandboxes.mockImplementationOnce(async (input) => {
      input.log?.('eve: built sandbox template "root" on backend "docker".');
    });

    startDevelopmentSandboxPrewarmInBackground({
      appRoot,
      compiledArtifactsSource,
    });
    await Promise.resolve();
    await Promise.resolve();

    const firstLogs: string[] = [];
    subscribeDevelopmentSandboxPrewarmLogs({
      appRoot,
      log: (message) => firstLogs.push(message),
    });
    const secondLogs: string[] = [];
    subscribeDevelopmentSandboxPrewarmLogs({
      appRoot,
      log: (message) => secondLogs.push(message),
    });

    expect(firstLogs).toEqual(['eve: built sandbox template "root" on backend "docker".']);
    expect(secondLogs).toEqual([]);
  });

  it("skips completed prewarm work when the sandbox signature is unchanged", async () => {
    const appRoot = "/tmp/eve-signature-app";
    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);
    let prewarmCount = 0;
    mocks.prewarmAppSandboxes.mockImplementation(async (input) => {
      if (input.shouldPrewarmSignature?.("signature-a") === false) {
        return;
      }
      prewarmCount += 1;
      input.onPrewarmSignature?.("signature-a");
    });

    startDevelopmentSandboxPrewarmInBackground({
      appRoot,
      compiledArtifactsSource,
    });
    await Promise.resolve();
    await Promise.resolve();
    startDevelopmentSandboxPrewarmInBackground({
      appRoot,
      compiledArtifactsSource,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(prewarmCount).toBe(1);
  });
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}
