import { afterEach, describe, expect, it, vi } from "vitest";

import type { VercelImagePreparedArtifact } from "#execution/sandbox/bindings/vercel-image.js";
import { createVercelReusedImageSandboxProvider } from "#execution/sandbox/bindings/vercel-reused.js";
import { createFakeVercelOidcToken } from "#internal/testing/vercel-oidc-token.js";
import type { SandboxProviderSessionContext } from "#shared/sandbox-provider.js";

const artifact: VercelImagePreparedArtifact = {
  image: `vcr.vercel.com/account/project/image@sha256:${"a".repeat(64)}`,
  mounts: [],
  version: 1,
};

afterEach(() => vi.unstubAllEnvs());

function context(id: string): SandboxProviderSessionContext {
  return {
    host: {
      loadOptionalPackage: async ({ importModule }) => await importModule(),
      resolveProjectPath: (path) => path,
    },
    session: {
      auth: { current: null, initiator: null },
      id,
      turn: { id: "turn", sequence: 0 },
    },
    storagePath: "/tmp/eve-reused",
  };
}

function fixture(existing = false) {
  const sandbox = {
    delete: vi.fn(async () => {}),
    name: "native",
    status: "running",
    tags: undefined,
    update: vi.fn(async () => {}),
  };
  const create = vi.fn(async () => sandbox);
  const get = vi.fn(async () => (existing ? sandbox : null));
  vi.stubEnv(
    "VERCEL_OIDC_TOKEN",
    createFakeVercelOidcToken({
      owner: "account",
      owner_id: "team-id",
      project: "project",
      project_id: "project-id",
    }),
  );
  vi.stubEnv("VERCEL_ORG_ID", "team-id");
  vi.stubEnv("VERCEL_PROJECT_ID", "project-id");
  return {
    create,
    get,
    provider: createVercelReusedImageSandboxProvider(
      { networkPolicy: "deny-all", resources: { vcpus: 4 } },
      {
        ensureBaseRuntime: vi.fn(async () => {}),
        hydrateResources: vi.fn(async () => {}),
        loadModule: async () => ({ Sandbox: { create, get } }) as never,
        resourcePublisher: { prepare: vi.fn(), resolveMounts: vi.fn(async () => ({})) },
        waitForImage: vi.fn(async () => {}),
      },
    ),
    sandbox,
  };
}

describe("createVercelReusedImageSandboxProvider", () => {
  it("derives one native identity across eve sessions", async () => {
    const first = fixture();
    const startedA = await first.provider.start(context("session-a"), undefined, artifact);
    const second = fixture();
    const startedB = await second.provider.start(context("session-b"), undefined, artifact);
    expect(startedB.state).toEqual(startedA.state);
  });

  it("returns a logical view without mutable network or native teardown", async () => {
    const value = fixture();
    const result = await value.provider.start(context("session-a"), undefined, artifact);
    expect(result.handle.sandbox.setNetworkPolicy).toBeUndefined();
    await result.handle.onSessionStop();
    await result.handle.onRuntimeShutdown();
    await result.handle.onSessionDelete();
    expect(value.sandbox.delete).not.toHaveBeenCalled();
  });

  it("resumes from minimal shared provider state", async () => {
    const first = fixture();
    const started = await first.provider.start(context("session-a"), undefined, artifact);
    const second = fixture(true);
    await expect(
      second.provider.resume(context("session-b"), undefined, artifact, started.state),
    ).resolves.toBeTruthy();
    expect(second.create).not.toHaveBeenCalled();
  });
});
