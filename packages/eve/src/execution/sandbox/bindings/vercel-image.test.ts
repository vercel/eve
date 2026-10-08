import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createVercelImageSandboxProvider,
  type VercelImagePreparedArtifact,
} from "#execution/sandbox/bindings/vercel-image.js";
import { createFakeVercelOidcToken } from "#internal/testing/vercel-oidc-token.js";
import { VERCEL_EVE_SANDBOX_IMAGE } from "#execution/sandbox/bindings/eve-image.js";
import type {
  SandboxProviderPrepareContext,
  SandboxProviderSessionContext,
} from "#shared/sandbox-provider.js";

const artifact: VercelImagePreparedArtifact = {
  image: `vcr.vercel.com/account/project/image@sha256:${"a".repeat(64)}`,
  mounts: [],
  version: 1,
};

const artifactWithDrive: VercelImagePreparedArtifact = {
  ...artifact,
  mounts: [
    {
      driveName: `eve-sbx-res-${"b".repeat(32)}`,
      mountPath: "/eve/resources/skills",
      region: "iad1",
      resourceKey: "skills-key",
    },
  ],
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

function createProvider(
  input: { readonly existing?: boolean; readonly missingForkOnCleanup?: boolean } = {},
) {
  const sandbox = {
    delete: vi.fn(async () => {}),
    name: "native",
    status: "running",
    stop: vi.fn(async () => {}),
    tags: undefined,
    update: vi.fn(async () => {}),
  };
  let nativeSandbox: typeof sandbox | null = input.existing ? sandbox : null;
  const create = vi.fn(async () => {
    nativeSandbox = sandbox;
    return sandbox;
  });
  const get = vi.fn(async () => nativeSandbox);
  const deleteFork = vi.fn(async () => {});
  const sourceDrive = {
    driveId: "source-drive-id",
    fork: vi.fn(async ({ name }: { name: string }) => ({
      name,
      parentDriveId: "source-drive-id",
    })),
    region: "iad1",
  };
  const getDrive = vi.fn(async ({ name }: { name: string }) => {
    if (name.startsWith("eve-sbx-fork-")) {
      if (input.missingForkOnCleanup) {
        throw Object.assign(new Error("missing"), { status: 404 });
      }
      return { delete: deleteFork, name };
    }
    return sourceDrive;
  });
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
  const module = { Drive: { get: getDrive }, Sandbox: { create, get } } as never;
  const provider = createVercelImageSandboxProvider(
    {},
    {
      createImagePublisher: () => ({ publish }),
      ensureBaseRuntime: vi.fn(async () => {}),
      hydrateResources: vi.fn(async () => {}),
      loadDeleteModule: async () => module,
      loadModule: async () => module,
      waitForImage: vi.fn(async () => {}),
    },
  );
  return {
    create,
    deleteFork,
    get,
    getDrive,
    provider,
    publish,
    sandbox,
    sourceDrive,
  };
}

function prepareContext(hasDockerfile = true): SandboxProviderPrepareContext {
  const error = Object.assign(new Error("missing"), { code: "ENOENT" });
  return {
    files: {
      list: async () => (hasDockerfile ? ["Dockerfile"] : []),
      read: async () => {
        if (!hasDockerfile) throw error;
        return Buffer.from("FROM alpine:3.22\n");
      },
      readText: async () => "FROM alpine:3.22\n",
    },
    host: context().host,
    resources: { source: { kind: "none" } },
    sourceRevision: "test-source-revision",
    storagePath: "/tmp/eve-sandbox",
  };
}

describe("createVercelImageSandboxProvider", () => {
  it("uses the eve base image when no Dockerfile exists", async () => {
    const { provider, publish } = createProvider();
    await expect(provider.prepare(prepareContext(false))).resolves.toEqual({
      image: VERCEL_EVE_SANDBOX_IMAGE,
      mounts: [],
      version: 1,
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("starts with deterministic session state and resumes the same native sandbox", async () => {
    const first = createProvider();
    const started = await first.provider.start(context("session-a"), {}, artifact);
    expect(started.state).toMatchObject({
      forks: [],
      sandboxName: expect.stringMatching(/^eve-sbx-vercel-image-/u),
      version: 3,
    });
    const second = createProvider({ existing: true });
    await expect(
      second.provider.resume(context("session-a"), artifact, started.state),
    ).resolves.toBeTruthy();
    expect(second.create).not.toHaveBeenCalled();
  });

  it("stores the session Drive fork identity in provider state", async () => {
    const { provider, sourceDrive } = createProvider();
    const started = await provider.start(context("session-a"), {}, artifactWithDrive);

    expect(sourceDrive.fork).toHaveBeenCalledOnce();
    expect(started.state).toMatchObject({
      forks: [
        {
          driveName: expect.stringMatching(/^eve-sbx-fork-[a-f0-9]{32}$/u),
          mountPath: "/eve/resources/skills",
          resourceKey: "skills-key",
          sourceDriveName: artifactWithDrive.mounts[0]?.driveName,
        },
      ],
      version: 3,
    });
  });

  it("deletes the sandbox before its session Drive forks when the session ends", async () => {
    const { deleteFork, provider, sandbox } = createProvider();
    const started = await provider.start(context("session-a"), {}, artifactWithDrive);

    await provider.onSessionEnd?.(context("session-a"), artifactWithDrive, started.state, {
      reason: "expired",
    });

    expect(sandbox.delete).toHaveBeenCalledOnce();
    expect(deleteFork).toHaveBeenCalledOnce();
    expect(sandbox.delete.mock.invocationCallOrder[0]).toBeLessThan(
      deleteFork.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("deletes session Drive forks when authored code deletes the sandbox", async () => {
    const { deleteFork, provider, sandbox } = createProvider();
    const started = await provider.start(context("session-a"), {}, artifactWithDrive);

    await started.handle.onSandboxDelete();

    expect(sandbox.delete).toHaveBeenCalledOnce();
    expect(deleteFork).toHaveBeenCalledOnce();
  });

  it("treats missing session resources as already cleaned up", async () => {
    const { get, provider, sandbox } = createProvider({ missingForkOnCleanup: true });
    const started = await provider.start(context("session-a"), {}, artifactWithDrive);
    get.mockResolvedValueOnce(null);

    await expect(
      provider.onSessionEnd?.(context("session-a"), artifactWithDrive, started.state, {
        reason: "failed",
      }),
    ).resolves.toBeUndefined();
    expect(sandbox.delete).not.toHaveBeenCalled();
  });

  it("treats a missing session Drive fork as already cleaned up", async () => {
    const { provider, sandbox } = createProvider({ missingForkOnCleanup: true });
    const started = await provider.start(context("session-a"), {}, artifactWithDrive);

    await expect(
      provider.onSessionEnd?.(context("session-a"), artifactWithDrive, started.state, {
        reason: "completed",
      }),
    ).resolves.toBeUndefined();
    expect(sandbox.delete).toHaveBeenCalledOnce();
  });

  it("derives distinct native identity for each eve session", async () => {
    const first = createProvider();
    const startedA = await first.provider.start(context("session-a"), {}, artifact);
    const second = createProvider();
    const startedB = await second.provider.start(context("session-b"), {}, artifact);
    expect(startedB.state).not.toEqual(startedA.state);
  });

  it("rejects incompatible serialized session state", async () => {
    const { provider } = createProvider();
    await expect(
      provider.resume(context("session-a"), artifact, {
        forks: [],
        generation: "wrong",
        sandboxName: "wrong",
        version: 3,
      }),
    ).rejects.toThrow("incompatible");
  });
});
