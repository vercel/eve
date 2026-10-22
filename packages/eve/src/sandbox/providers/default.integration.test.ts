import { mkdir } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { shutdownActiveSandboxHandles } from "#execution/sandbox/active-handles.js";
import { isLinuxDockerDaemonAvailableSync } from "#execution/sandbox/bindings/local.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { createSandboxProviderFiles } from "#execution/sandbox/provider-files.js";
import { createSandboxProviderHost } from "#execution/sandbox/provider-host.js";
import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { writeSandboxPreparedArtifactsManifest } from "#runtime/sandbox/prepared-artifacts.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { DefaultSandbox, type DefaultSandboxSession } from "#sandbox/providers/default.js";
import type { SandboxState } from "#sandbox/state.js";
import { getSandboxEnvironmentRuntime, type SandboxSelector } from "#shared/sandbox-environment.js";
import { createSandboxProviderResources } from "#shared/sandbox-provider.js";

vi.mock("#execution/sandbox/bindings/local.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/sandbox/bindings/local.js")>()),
  isLinuxDockerDaemonAvailableSync: vi.fn(() => false),
}));

const createScratchDirectory = useTemporaryDirectories();

afterEach(async () => {
  await shutdownActiveSandboxHandles();
  vi.unstubAllEnvs();
  vi.mocked(isLinuxDockerDaemonAvailableSync).mockClear();
});

/** Prepares the environment the way the build does and records the artifact. */
async function build(environment: ReturnType<typeof DefaultSandbox.environment>, dev: boolean) {
  const appRoot = await createScratchDirectory("eve-default-sandbox-");
  const log = vi.fn();
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("EVE_DEV", dev ? "1" : "");
  const artifact = await getSandboxEnvironmentRuntime(environment).implementation.prepare({
    files: createSandboxProviderFiles(`${appRoot}/agent/sandbox`),
    host: createSandboxProviderHost(appRoot),
    log,
    resources: createSandboxProviderResources({}),
    sourceRevision: "revision",
    storagePath: resolveSandboxCacheDirectory(appRoot),
  });
  const { compileDirectoryPath } = resolveRuntimeCompilerArtifactPaths(appRoot);
  await mkdir(compileDirectoryPath, { recursive: true });
  await writeSandboxPreparedArtifactsManifest({
    compileDirectoryPath,
    entries: [{ artifact, nodeId: "__root__", providerName: "default" }],
  });
  vi.unstubAllEnvs();
  return { appRoot, artifact, log };
}

async function access(input: {
  readonly appRoot: string;
  readonly environment: ReturnType<typeof DefaultSandbox.environment>;
  readonly selector: SandboxSelector;
  readonly state?: SandboxState;
}) {
  const registry: RuntimeSandboxRegistry = {
    sandbox: {
      definition: {
        environment: input.environment,
        kind: "independent",
        logicalPath: "sandbox.ts",
        revisionHash: "revision",
        selector: input.selector,
        sourceId: "sandbox",
        sourceKind: "module",
      },
      workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
    },
  };
  return await ensureSandboxAccess({
    compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(input.appRoot),
    nodeId: "__root__",
    registry,
    sessionId: "session-1",
    state: input.state ?? null,
  });
}

describe("DefaultSandbox", () => {
  it("uses the provider its build recorded without probing the runtime host", async () => {
    const environment = DefaultSandbox.environment();
    const { appRoot, artifact } = await build(environment, true);
    expect(artifact).toMatchObject({ provider: "just-bash" });
    vi.mocked(isLinuxDockerDaemonAvailableSync).mockClear();

    // A runtime that probed the host would now select Vercel Sandbox.
    vi.stubEnv("VERCEL", "1");
    const sandbox = await access({
      appRoot,
      environment,
      selector: defineSandbox(() => environment.open()),
    });
    await expect((await sandbox.get())?.run({ command: "echo ready" })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "ready\n",
    });
    await expect(sandbox.captureState()).resolves.toMatchObject({
      session: { providerName: "default", state: { provider: "just-bash" } },
    });
    expect(isLinuxDockerDaemonAvailableSync).not.toHaveBeenCalled();
  });

  it("builds for production without Vercel or Docker and fails at open with guidance", async () => {
    const environment = DefaultSandbox.environment();
    const { appRoot, artifact, log } = await build(environment, false);
    expect(artifact).toEqual({ provider: null });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("do not fall back to just-bash"));

    const sandbox = await access({
      appRoot,
      environment,
      selector: defineSandbox(() => environment.open()),
    });
    await expect(sandbox.get()).rejects.toThrow(
      /Start Docker and rebuild, deploy to Vercel, or select a provider explicitly/,
    );
  });

  it("rejects network policies that just-bash cannot apply", async () => {
    const environment = DefaultSandbox.environment();
    const { appRoot } = await build(environment, true);

    const denied = await access({
      appRoot,
      environment,
      selector: defineSandbox(() => environment.open({ networkPolicy: "deny-all" })),
    });
    await expect(denied.get()).rejects.toThrow(/just-bash, which always allows network access/);

    let opened: DefaultSandboxSession | undefined;
    const allowed = await access({
      appRoot,
      environment,
      selector: defineSandbox(async () => (opened = await environment.open())),
    });
    await allowed.get();
    await expect(opened?.setNetworkPolicy("allow-all")).resolves.toBeUndefined();
    await expect(opened?.setNetworkPolicy("deny-all")).rejects.toThrow(/just-bash/);
  });

  it("ends a sandbox no checkpoint recorded through the provider its build selected", async () => {
    const environment = DefaultSandbox.environment();
    const { appRoot } = await build(environment, true);
    const selector = defineSandbox(() => environment.open());
    const opened = await access({ appRoot, environment, selector });
    await (await opened.get())?.writeTextFile({ content: "kept", path: "marker.txt" });
    await opened.stop();

    await (await access({ appRoot, environment, selector })).end("completed");

    const reopened = await access({ appRoot, environment, selector });
    await expect(
      (await reopened.get())?.run({ command: "test -f marker.txt" }),
    ).resolves.toMatchObject({ exitCode: 1 });
  });

  describe("sessions saved before DefaultSandbox recorded its own state", () => {
    it("resumes the sandbox of the provider it picked", async () => {
      const environment = DefaultSandbox.environment();
      const { appRoot } = await build(environment, true);
      const first = await access({
        appRoot,
        environment,
        selector: defineSandbox(() => environment.open()),
      });
      await (await first.get())?.writeTextFile({ content: "kept", path: "marker.txt" });
      const recorded = (await first.captureState()).session?.state;
      await first.stop();
      if (typeof recorded !== "object" || recorded === null || !("state" in recorded)) {
        throw new Error("Expected DefaultSandbox session state.");
      }

      const selector = vi.fn(() => environment.open());
      const resumed = await access({
        appRoot,
        environment,
        selector: defineSandbox(selector),
        state: {
          session: {
            generation: "generation-1",
            providerName: "just-bash",
            state: recorded.state,
            stateProtocolVersion: 1,
          },
        },
      });

      await expect((await resumed.get())?.readTextFile({ path: "marker.txt" })).resolves.toBe(
        "kept",
      );
      expect(selector).not.toHaveBeenCalled();
      await expect(resumed.captureState()).resolves.toEqual({
        session: {
          generation: "generation-1",
          providerName: "default",
          state: recorded,
          stateProtocolVersion: 1,
        },
      });
    });

    it("starts a fresh sandbox when its provider no longer speaks the recorded protocol", async () => {
      const environment = DefaultSandbox.environment();
      const { appRoot } = await build(environment, true);
      const first = await access({
        appRoot,
        environment,
        selector: defineSandbox(() => environment.open()),
      });
      await first.get();
      const recorded = (await first.captureState()).session?.state;
      await first.stop();
      if (typeof recorded !== "object" || recorded === null || !("state" in recorded)) {
        throw new Error("Expected DefaultSandbox session state.");
      }

      const selector = vi.fn(() => environment.open());
      const sandbox = await access({
        appRoot,
        environment,
        selector: defineSandbox(selector),
        state: {
          session: { providerName: "just-bash", state: recorded.state, stateProtocolVersion: 2 },
        },
      });

      await expect(sandbox.get()).resolves.toBeTruthy();
      expect(selector).toHaveBeenCalledOnce();
    });

    it("starts a fresh sandbox when the build selected another provider", async () => {
      const environment = DefaultSandbox.environment();
      const { appRoot } = await build(environment, true);
      const selector = vi.fn(() => environment.open());

      const sandbox = await access({
        appRoot,
        environment,
        selector: defineSandbox(selector),
        state: {
          session: {
            providerName: "docker",
            state: { containerName: "eve-sbx-old", version: 2 },
            stateProtocolVersion: 1,
          },
        },
      });

      await expect(sandbox.get()).resolves.toBeTruthy();
      expect(selector).toHaveBeenCalledOnce();
      await expect(sandbox.captureState()).resolves.toMatchObject({
        session: { providerName: "default", state: { provider: "just-bash" } },
      });
    });
  });
});
