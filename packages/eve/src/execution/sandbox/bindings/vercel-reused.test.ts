import { afterEach, describe, expect, it, vi } from "vitest";

import type { CreateVercelImageProviderInput } from "#execution/sandbox/bindings/vercel-image.js";
import { createVercelReusedImageSandboxProvider } from "#execution/sandbox/bindings/vercel-reused.js";
import { createFakeVercelOidcToken } from "#internal/testing/vercel-oidc-token.js";

function createSandbox(name: string) {
  return {
    delete: vi.fn(async () => {}),
    name,
    status: "running",
    tags: undefined,
    update: vi.fn(async () => {}),
  };
}

afterEach(() => vi.unstubAllEnvs());

function createProvider(
  input: {
    readonly createSandbox?: () => Promise<ReturnType<typeof createSandbox>>;
    readonly getSandbox?: (input: {
      readonly name: string;
    }) => Promise<ReturnType<typeof createSandbox> | null>;
    readonly hydrateResources?: () => Promise<void>;
    readonly key?: string;
  } = {},
) {
  const sandbox = createSandbox("native-reused-sandbox");
  const create = vi.fn(input.createSandbox ?? (async () => sandbox));
  const get = vi.fn(
    input.getSandbox ??
      (async (_input: { readonly name: string }) => {
        throw Object.assign(new Error("not found"), { status: 404 });
      }),
  );
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
  const providerInput: CreateVercelImageProviderInput = {
    createImagePublisher: () => ({
      publish: async () => `vcr.vercel.com/account/project/image@sha256:${"a".repeat(64)}`,
    }),
    ensureBaseRuntime: vi.fn(async () => {}),
    hydrateResources: input.hydrateResources ?? vi.fn(async () => {}),
    loadModule: async () => ({ Sandbox: { create, get } }) as never,
    resourcePublisher: {
      prepare: vi.fn(),
      resolveMounts: vi.fn(async () => ({})),
    },
    waitForImage: vi.fn(async () => {}),
  };
  return {
    create,
    get,
    provider: createVercelReusedImageSandboxProvider(
      {
        key: input.key ?? "trusted-team",
        networkPolicy: "deny-all",
        resources: { vcpus: 4 },
      },
      providerInput,
    ),
    sandbox,
  };
}

const artifact = {
  image: `vcr.vercel.com/account/project/image@sha256:${"a".repeat(64)}`,
  mounts: [],
  version: 1 as const,
};
const source = { artifact, kind: "prepared" as const, templateName: "template-key" };

function openContext(sessionId: string) {
  return {
    appRoot: "/app",
    instance: { kind: "create" as const, name: sessionId },
    options: undefined,
    resources: { source: { kind: "reference" as const, key: "resources" } },
    tags: { sessionId },
  };
}

describe("createVercelReusedImageSandboxProvider", () => {
  it("rejects an empty reuse key", () => {
    expect(() => createVercelReusedImageSandboxProvider({ key: "  " })).toThrow(
      "keys must be non-empty",
    );
  });

  it("reuses one native sandbox while returning session-owned logical identities", async () => {
    const { create, get, provider, sandbox } = createProvider();
    const first = await provider.open(openContext("eve-session-a"), source);
    get.mockResolvedValue(sandbox);
    const second = await provider.open(openContext("eve-session-b"), source);

    const nativeName = get.mock.calls[0]?.[0].name;
    expect(nativeName).toMatch(/^eve-sbx-reuse-[a-f0-9]{32}$/u);
    expect(get.mock.calls[1]?.[0].name).toBe(nativeName);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: nativeName,
        networkPolicy: "deny-all",
        persistent: true,
        resources: { vcpus: 4 },
        tags: undefined,
      }),
    );
    expect(first.sandbox.id).toBe("eve-session-a");
    expect(second.sandbox.id).toBe("eve-session-b");
  });

  it("rotates native identity with the prepared environment generation", async () => {
    const { get, provider } = createProvider();
    await provider.open(openContext("eve-session-a"), source);
    await provider.open(openContext("eve-session-b"), {
      ...source,
      templateName: "template-key-v2",
    });

    expect(get.mock.calls[0]?.[0].name).not.toBe(get.mock.calls[1]?.[0].name);
  });

  it("attaches when another opener creates the reused sandbox concurrently", async () => {
    const sandbox = createSandbox("reused");
    let lookups = 0;
    const { create, provider } = createProvider({
      createSandbox: async () => {
        throw Object.assign(new Error("already exists"), { status: 409 });
      },
      getSandbox: async () => {
        lookups += 1;
        return lookups === 1 ? null : sandbox;
      },
    });

    await expect(provider.open(openContext("eve-session-a"), source)).resolves.toBeTruthy();
    expect(create).toHaveBeenCalledOnce();
    expect(lookups).toBe(2);
  });

  it("does not delete reused compute when session hydration fails", async () => {
    const cause = new Error("hydrate failed");
    const { provider, sandbox } = createProvider({
      hydrateResources: async () => {
        throw cause;
      },
    });

    await expect(provider.open(openContext("eve-session-a"), source)).rejects.toBe(cause);
    expect(sandbox.delete).not.toHaveBeenCalled();
  });

  it("does not let one logical session tear down reused compute", async () => {
    const { provider, sandbox } = createProvider();
    const handle = await provider.open(openContext("eve-session-a"), source);

    await handle.stop();
    await handle.shutdown();
    await handle.delete();

    expect(sandbox.delete).not.toHaveBeenCalled();
  });
});
