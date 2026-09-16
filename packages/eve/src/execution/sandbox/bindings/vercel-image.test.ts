import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createVercelImageSandboxProvider,
  type VercelImagePreparedArtifact,
} from "#execution/sandbox/bindings/vercel-image.js";
import { createFakeVercelOidcToken } from "#internal/testing/vercel-oidc-token.js";
import type {
  SandboxProviderPrepareContext,
  SandboxProviderSessionContext,
} from "#shared/sandbox-provider.js";

const artifact: VercelImagePreparedArtifact = {
  image: `vcr.vercel.com/account/project/image@sha256:${"a".repeat(64)}`,
  mounts: [],
  version: 1,
};

afterEach(() => vi.unstubAllEnvs());

function context(sessionId = "session-a"): SandboxProviderSessionContext {
  return {
    host: {
      loadOptionalPackage: async ({ importModule }) => await importModule(),
      resolveProjectPath: (path) => path,
    },
    session: {
      auth: { current: null, initiator: null },
      id: sessionId,
      turn: { id: "turn", sequence: 0 },
    },
    storagePath: "/tmp/eve-sandbox",
  };
}

function createProvider(input: { readonly existing?: boolean } = {}) {
  const sandbox = {
    delete: vi.fn(async () => {}),
    name: "native",
    status: "running",
    tags: undefined,
    update: vi.fn(async () => {}),
  };
  const create = vi.fn(async () => sandbox);
  const get = vi.fn(async () => (input.existing ? sandbox : null));
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
  const publish = vi.fn(async () => artifact.image);
  const provider = createVercelImageSandboxProvider(
    {},
    {
      createImagePublisher: () => ({ publish }),
      ensureBaseRuntime: vi.fn(async () => {}),
      hydrateResources: vi.fn(async () => {}),
      loadModule: async () => ({ Sandbox: { create, get } }) as never,
      resourcePublisher: { prepare: vi.fn(), resolveMounts: vi.fn(async () => ({})) },
      waitForImage: vi.fn(async () => {}),
    },
  );
  return { create, get, provider, publish, sandbox };
}

function prepareContext(hasDockerfile = true): SandboxProviderPrepareContext {
  const error = Object.assign(new Error("missing"), { code: "ENOENT" });
  return {
    files: {
      glob: async () => (hasDockerfile ? ["Dockerfile"] : []),
      read: async () => {
        if (!hasDockerfile) throw error;
        return Buffer.from("FROM alpine:3.22\n");
      },
      readText: async () => "FROM alpine:3.22\n",
    },
    host: context().host,
    resources: { source: { kind: "none" } },
    storagePath: "/tmp/eve-sandbox",
  };
}

describe("createVercelImageSandboxProvider", () => {
  it("requires a colocated Dockerfile", async () => {
    const { provider } = createProvider();
    await expect(provider.prepare(prepareContext(false))).rejects.toThrow(
      "requires agent/sandbox/Dockerfile",
    );
  });

  it("starts with deterministic session state and resumes the same native sandbox", async () => {
    const first = createProvider();
    const started = await first.provider.start(context("session-a"), {}, artifact);
    expect(started.state).toMatchObject({
      sandboxName: expect.stringMatching(/^eve-sbx-vercel-image-/u),
      version: 1,
    });
    const second = createProvider({ existing: true });
    await expect(
      second.provider.resume(context("session-a"), {}, artifact, started.state),
    ).resolves.toBeTruthy();
    expect(second.create).not.toHaveBeenCalled();
  });

  it("rejects incompatible serialized session state", async () => {
    const { provider } = createProvider();
    await expect(
      provider.resume(context("session-a"), {}, artifact, {
        sandboxName: "wrong",
        version: 1,
      }),
    ).rejects.toThrow("incompatible");
  });
});
