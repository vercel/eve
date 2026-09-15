import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createVercelImageSandboxProvider,
  type VercelImagePreparedArtifact,
} from "#execution/sandbox/bindings/vercel-image.js";
import { VercelImageResourceUnavailableError } from "#execution/sandbox/bindings/vercel-image-resources.js";
import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";
import { createFakeVercelOidcToken } from "#internal/testing/vercel-oidc-token.js";
import type { SandboxProviderPrepareContext } from "#shared/sandbox-provider.js";

function prepareContext(
  input: Partial<SandboxProviderPrepareContext> = {},
): SandboxProviderPrepareContext {
  return {
    appRoot: "/app",
    dockerfile: {
      contentHash: "dockerfile-context",
      contextPath: "/app/agent/sandbox",
      path: "/app/agent/sandbox/Dockerfile",
    },
    hasPreparation: false,
    resources: {
      source: { kind: "inline", key: "resources" },
      workspace: {
        files: [{ content: "seed", relativePath: "seed.txt" }],
        key: "workspace-key",
        mountPath: "/eve/resources/workspace",
        targetPath: "/workspace",
      },
    },
    runPreparation: async () => {},
    templateName: "template-key",
    ...input,
  };
}

function createSandbox(name: string) {
  return {
    name,
    status: "running",
    tags: undefined,
    update: vi.fn(async () => {}),
  };
}

afterEach(() => vi.unstubAllEnvs());

function createProvider(
  input: {
    readonly hydrateResources?: () => Promise<void>;
    readonly resolveMounts?: () => Promise<
      Record<string, { readonly drive: string; readonly mode: "snapshot" }>
    >;
  } = {},
) {
  const publish = vi.fn(
    async () => `vcr.vercel.com/account/project/image@sha256:${"a".repeat(64)}`,
  );
  const prepareResource = vi.fn(async () => ({
    artifact: {
      driveName: "eve-sbx-res-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      mountPath: "/eve/resources/workspace",
      region: "iad1",
      resourceKey: "workspace-key",
    },
    reused: true,
  }));
  const resolveMounts = vi.fn(
    input.resolveMounts ??
      (async () => ({
        "/eve/resources/workspace": {
          drive: "eve-sbx-res-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          mode: "snapshot" as const,
        },
      })),
  );
  const sandbox = { ...createSandbox("session-name"), delete: vi.fn(async () => {}) };
  const create = vi.fn(async () => sandbox);
  const get = vi.fn(async () => {
    throw Object.assign(new Error("not found"), { status: 404 });
  });
  const token = createFakeVercelOidcToken({
    owner: "account",
    owner_id: "team-id",
    project: "project",
    project_id: "project-id",
  });
  vi.stubEnv("VERCEL_OIDC_TOKEN", token);
  vi.stubEnv("VERCEL_ORG_ID", "team-id");
  vi.stubEnv("VERCEL_PROJECT_ID", "project-id");
  const provider = createVercelImageSandboxProvider(
    {},
    {
      createImagePublisher: () => ({ publish }),
      hydrateResources: input.hydrateResources ?? vi.fn(async () => {}),
      loadModule: async () => ({ Sandbox: { create, get } }) as never,
      resourcePublisher: { prepare: prepareResource, resolveMounts },
    },
  );
  return { create, prepareResource, provider, publish, resolveMounts, sandbox, token };
}

describe("createVercelImageSandboxProvider", () => {
  it("requires a colocated Dockerfile", async () => {
    const { provider } = createProvider();
    await expect(provider.prepare(prepareContext({ dockerfile: undefined }))).rejects.toThrow(
      "requires agent/sandbox/Dockerfile",
    );
  });

  it("rejects preparation callbacks that cannot be captured in the image", async () => {
    const { provider } = createProvider();
    await expect(provider.prepare(prepareContext({ hasPreparation: true }))).rejects.toThrow(
      "does not support prepare",
    );
  });

  it("publishes a digest-pinned image and resource artifacts without credentials", async () => {
    const { prepareResource, provider, publish, token } = createProvider();
    const result = await provider.prepare(prepareContext());

    expect(publish).toHaveBeenCalledWith({
      dockerfile: expect.objectContaining({ path: "/app/agent/sandbox/Dockerfile" }),
      imageReference: expect.stringMatching(/^vcr\.vercel\.com\/account\/project\/eve-sandbox:/u),
      signal: undefined,
    });
    expect(prepareResource).toHaveBeenCalledOnce();
    expect(result).toEqual({
      artifact: {
        image: `vcr.vercel.com/account/project/image@sha256:${"a".repeat(64)}`,
        mounts: [expect.objectContaining({ resourceKey: "workspace-key" })],
        version: 1,
      },
      reused: false,
    });
    expect(JSON.stringify(result.artifact)).not.toContain(token);
  });

  it("creates a named persistent sandbox from the exact prepared artifact", async () => {
    const { create, provider, resolveMounts } = createProvider();
    const artifact: VercelImagePreparedArtifact = {
      image: `vcr.vercel.com/account/project/image@sha256:${"a".repeat(64)}`,
      mounts: [
        {
          driveName: "eve-sbx-res-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          mountPath: "/eve/resources/workspace",
          region: "iad1",
          resourceKey: "workspace-key",
        },
      ],
      version: 1,
    };

    const handle = await provider.getOrCreate(
      {
        appRoot: "/app",
        options: { networkPolicy: "deny-all" },
        resources: { source: { kind: "reference", key: "resources" } },
        session: { kind: "create", name: "session-name" },
      },
      { artifact, kind: "prepared", templateName: "template-key" },
    );

    expect(resolveMounts).toHaveBeenCalledWith(
      expect.objectContaining({ mounts: artifact.mounts }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        image: artifact.image,
        mounts: {
          "/eve/resources/workspace": {
            drive: "eve-sbx-res-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            mode: "snapshot",
          },
        },
        name: "session-name",
        networkPolicy: "deny-all",
        persistent: true,
      }),
    );
    expect(handle.sandbox.id).toBe("session-name");
  });

  it("rejects artifacts with unpinned images or provider-controlled mount paths", async () => {
    const { provider } = createProvider();
    await expect(
      provider.getOrCreate(
        {
          appRoot: "/app",
          options: {},
          resources: { source: { kind: "reference", key: "resources" } },
          session: { kind: "create", name: "session-name" },
        },
        {
          artifact: {
            image: "vcr.vercel.com/account/project/image:latest",
            mounts: [
              {
                driveName: "eve-sbx-res-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                mountPath: "/etc",
                region: "iad1",
                resourceKey: "workspace-key",
              },
            ],
            version: 1,
          },
          kind: "prepared",
          templateName: "template-key",
        },
      ),
    ).rejects.toThrow("Invalid prepared Vercel image artifact");
  });

  it("classifies a missing prepared Drive as an unprovisioned template", async () => {
    const { provider } = createProvider({
      resolveMounts: async () => {
        throw new VercelImageResourceUnavailableError("workspace-key");
      },
    });
    const artifact: VercelImagePreparedArtifact = {
      image: `vcr.vercel.com/account/project/image@sha256:${"a".repeat(64)}`,
      mounts: [
        {
          driveName: "eve-sbx-res-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          mountPath: "/eve/resources/workspace",
          region: "iad1",
          resourceKey: "workspace-key",
        },
      ],
      version: 1,
    };

    await expect(
      provider.getOrCreate(
        {
          appRoot: "/app",
          options: {},
          resources: { source: { kind: "reference", key: "resources" } },
          session: { kind: "create", name: "session-name" },
        },
        { artifact, kind: "prepared", templateName: "template-key" },
      ),
    ).rejects.toBeInstanceOf(SandboxTemplateNotProvisionedError);
  });

  it("deletes a newly created sandbox when resource hydration fails", async () => {
    const cause = new Error("hydrate failed");
    const { provider, sandbox } = createProvider({
      hydrateResources: async () => {
        throw cause;
      },
    });
    const artifact: VercelImagePreparedArtifact = {
      image: `vcr.vercel.com/account/project/image@sha256:${"a".repeat(64)}`,
      mounts: [],
      version: 1,
    };

    await expect(
      provider.getOrCreate(
        {
          appRoot: "/app",
          options: {},
          resources: { source: { kind: "reference", key: "resources" } },
          session: { kind: "create", name: "session-name" },
        },
        { artifact, kind: "prepared", templateName: "template-key" },
      ),
    ).rejects.toBe(cause);
    expect(sandbox.delete).toHaveBeenCalledOnce();
  });

  it("rejects the base source branch", async () => {
    const { provider } = createProvider();
    await expect(
      provider.getOrCreate(
        {
          appRoot: "/app",
          options: {},
          resources: { source: { kind: "none" } },
          session: { kind: "create", name: "session-name" },
        },
        { kind: "base" },
      ),
    ).rejects.toThrow("requires a prepared Vercel image artifact");
  });
});
