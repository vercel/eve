import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createVercelEveImageSandbox } from "#execution/sandbox/bindings/vercel-create-sdk.js";
import type { VercelModule } from "#execution/sandbox/bindings/vercel-sdk-types.js";
import {
  createVercelSandboxResource,
  prewarmVercelSandboxTemplate,
  referenceVercelSandboxResource,
  restoreVercelSandboxResource,
  shutdownVercelSandboxResource,
  type VercelSandboxDependencies,
  type VercelSandboxTemplateReference,
} from "#execution/sandbox/bindings/vercel.js";
import {
  SandboxResourceUnavailableError,
  SandboxTemplateUnavailableError,
} from "#shared/sandbox-errors.js";
import type { SandboxProviderContext } from "#shared/sandbox-value.js";

// The credential fallback consults the developer's Vercel CLI auth and the
// repo's `.vercel` project link; on a linked, logged-in machine it would
// inject real project credentials into the asserted SDK calls.
vi.mock("#compiled/@vercel/oidc/index.js", () => ({
  getVercelOidcToken: vi.fn(async () => {
    throw new Error("No ambient Vercel OIDC token in unit tests.");
  }),
}));

const IMMUTABLE_VERCEL_IMAGE = `vcr.vercel.com/eve/runtime@sha256:${"a".repeat(64)}`;

function createMockCommandResult() {
  return {
    exitCode: 0,
    stderr: vi.fn().mockResolvedValue(""),
    stdout: vi.fn().mockResolvedValue(""),
  };
}

function createMockDetachedCommand() {
  return {
    kill: vi.fn().mockResolvedValue(undefined),
    logs() {
      return (async function* () {
        yield* [];
      })();
    },
    wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
  };
}

function createMockSandbox(input: {
  readonly createdAt?: Date;
  readonly name: string;
  readonly snapshotId?: string;
  readonly status?: string;
  readonly tags?: Record<string, string>;
}) {
  const files = new Map<string, Buffer>();
  let tags = input.tags;
  return {
    createdAt: input.createdAt ?? new Date("2026-07-30T12:00:00.000Z"),
    currentSnapshotId: input.snapshotId ?? "",
    delete: vi.fn().mockResolvedValue(undefined),
    fs: {
      rm: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn().mockResolvedValue(undefined),
    },
    name: input.name,
    readFile: vi.fn(async (file: { readonly path: string }): Promise<object | null> => {
      const content = files.get(file.path);
      return content === undefined ? null : Readable.from([content]);
    }),
    runCommand: vi.fn().mockResolvedValue(createMockCommandResult()),
    snapshot: vi.fn().mockResolvedValue({ snapshotId: `${input.name}-snapshot` }),
    status: input.status ?? "running",
    stop: vi.fn().mockResolvedValue(undefined),
    get tags() {
      return tags;
    },
    update: vi.fn().mockImplementation(async (params: { tags?: Record<string, string> }) => {
      if (params.tags !== undefined) {
        tags = params.tags;
      }
    }),
    writeFiles: vi.fn(
      async (nextFiles: ReadonlyArray<{ readonly content: Uint8Array; readonly path: string }>) => {
        for (const file of nextFiles) {
          files.set(file.path, Buffer.from(file.content));
        }
      },
    ),
  };
}

function providerContext(
  resourceId: string,
  tags?: Readonly<Record<string, string>>,
): SandboxProviderContext {
  return {
    appRoot: "/tmp/test-app-root",
    resourceId,
    signal: new AbortController().signal,
    tags,
  };
}

function dependencies(
  sandboxModule: {
    readonly Sandbox: {
      readonly create: ReturnType<typeof vi.fn>;
      readonly get: ReturnType<typeof vi.fn>;
    };
  },
  createSandbox: VercelSandboxDependencies["createSandbox"] = createVercelEveImageSandbox,
): VercelSandboxDependencies {
  return {
    createSandbox,
    loadSandboxModule: async () => sandboxModule as never as VercelModule,
  };
}

beforeEach(() => {
  vi.stubEnv("VERCEL_OIDC_TOKEN", undefined);
  vi.stubEnv("VERCEL_ORG_ID", undefined);
  vi.stubEnv("VERCEL_PROJECT_ID", undefined);
  vi.stubEnv("VERCEL_TEAM_ID", undefined);
  vi.stubEnv("VERCEL_TOKEN", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("prewarmVercelSandboxTemplate", () => {
  it("creates a temporary sandbox, prepares it, and returns the exact snapshot reference", async () => {
    const templateSandbox = createMockSandbox({ name: "template-key" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValue(templateSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const reference = await prewarmVercelSandboxTemplate({
      dependencies: dependencies(sandboxModule),
      options: {
        networkPolicy: "deny-all",
        ports: [3000],
        timeout: 123_000,
      },
      async prepare(resource) {
        await resource.session.writeTextFile({
          content: "prepared",
          path: "/workspace/prepared.txt",
        });
      },
      templateId: "template-key",
    });

    expect(reference).toEqual({
      sandboxName: "template-key",
      snapshotId: "template-key-snapshot",
      templateKey: "template-key",
    });
    expect(sandboxModule.Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "vercel/eve:latest",
        name: "template-key",
        networkPolicy: "allow-all",
        persistent: false,
        ports: [3000],
        timeout: 123_000,
      }),
    );
    expect(templateSandbox.update).toHaveBeenCalledWith({ networkPolicy: "deny-all" });
    expect(templateSandbox.writeFiles).toHaveBeenCalledWith([
      {
        content: Buffer.from("prepared"),
        path: "/workspace/prepared.txt",
      },
    ]);
    expect(templateSandbox.snapshot).toHaveBeenCalledOnce();
  });

  it("reuses an immutable cached template and returns its provider reference directly", async () => {
    const templateSandbox = createMockSandbox({
      name: "template-key",
      snapshotId: "framework-snapshot",
    });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi.fn().mockResolvedValue(templateSandbox),
      },
    };
    const prepare = vi.fn();

    const reference = await prewarmVercelSandboxTemplate({
      dependencies: dependencies(sandboxModule),
      options: { image: IMMUTABLE_VERCEL_IMAGE },
      prepare,
      templateId: "template-key",
    });

    expect(reference).toEqual({
      sandboxName: "template-key",
      snapshotId: "framework-snapshot",
      templateKey: "template-key",
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(templateSandbox.snapshot).not.toHaveBeenCalled();
    expect(sandboxModule.Sandbox.create).not.toHaveBeenCalled();
  });

  it("rebuilds a cached template when its base cannot prove immutability", async () => {
    const stale = createMockSandbox({
      name: "template-key",
      snapshotId: "stale-snapshot",
    });
    const rebuilt = createMockSandbox({ name: "template-key" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValue(rebuilt),
        get: vi.fn().mockResolvedValue(stale),
      },
    };

    const reference = await prewarmVercelSandboxTemplate({
      dependencies: dependencies(sandboxModule),
      options: { image: "vercel/eve:latest" },
      async prepare() {},
      templateId: "template-key",
    });

    expect(stale.delete).toHaveBeenCalledOnce();
    expect(reference.snapshotId).toBe("template-key-snapshot");
    expect(rebuilt.snapshot).toHaveBeenCalledOnce();
  });

  it("deletes a partially prepared template before surfacing the failure", async () => {
    const templateSandbox = createMockSandbox({ name: "template-key" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValue(templateSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    await expect(
      prewarmVercelSandboxTemplate({
        dependencies: dependencies(sandboxModule),
        async prepare() {
          throw new Error("prepare failed");
        },
        templateId: "template-key",
      }),
    ).rejects.toThrow("prepare failed");

    expect(templateSandbox.delete).toHaveBeenCalledOnce();
    expect(templateSandbox.snapshot).not.toHaveBeenCalled();
  });

  it("retries when a cached provider snapshot disappears during prewarm", async () => {
    const stale = createMockSandbox({
      name: "template-key",
      snapshotId: "stale-snapshot",
    });
    const fresh = createMockSandbox({ name: "template-key" });
    const unavailable = Object.assign(new Error("snapshot disappeared"), { status: 410 });
    const createSandbox = vi.fn().mockRejectedValueOnce(unavailable).mockResolvedValueOnce(fresh);
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null),
      },
    };
    const log = vi.fn();

    const reference = await prewarmVercelSandboxTemplate({
      dependencies: dependencies(sandboxModule, async (input) => await createSandbox(input)),
      log,
      async prepare() {},
      templateId: "template-key",
    });

    expect(reference.snapshotId).toBe("template-key-snapshot");
    expect(createSandbox).toHaveBeenCalledTimes(2);
    expect(stale.delete).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("cached template disappeared; rebuilding sandbox template");
  });
});

describe("createVercelSandboxResource", () => {
  it("creates one persistent resource from an exact template reference", async () => {
    const sessionSandbox = createMockSandbox({ name: "session-key" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValue(sessionSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };
    const context = providerContext("session-key", {
      agent: "weather-agent",
      channel: "slack",
    });
    const template: VercelSandboxTemplateReference = {
      sandboxName: "template-key",
      snapshotId: "snapshot-frozen-at-build",
      templateKey: "template-key",
    };

    const resource = await createVercelSandboxResource({
      context,
      dependencies: dependencies(sandboxModule),
      options: {
        image: "ignored-when-template-backed",
        projectId: "prj_123",
        runtime: "node24",
        source: {
          revision: "main",
          type: "git",
          url: "https://example.com/repo.git",
        },
        tags: { owner: "platform" },
        teamId: "team_123",
        token: "must-not-be-persisted",
      } as never,
      template,
    });

    expect(sandboxModule.Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "session-key",
        persistent: true,
        source: {
          snapshotId: "snapshot-frozen-at-build",
          type: "snapshot",
        },
        tags: {
          agent: "weather-agent",
          channel: "slack",
          owner: "platform",
        },
      }),
    );
    const createInput = sandboxModule.Sandbox.create.mock.calls[0]?.[0];
    expect(createInput).not.toHaveProperty("image");
    expect(createInput).not.toHaveProperty("runtime");
    expect(resource.session.id).toBe("session-key");
    expect(referenceVercelSandboxResource(resource)).toEqual({
      configuration: {
        projectId: "prj_123",
        tags: { owner: "platform" },
        teamId: "team_123",
      },
      createdAt: "2026-07-30T12:00:00.000Z",
      name: "session-key",
      sessionKey: "session-key",
    });
  });

  it("uses the framework resource identity unless the app intentionally supplies a name", async () => {
    const first = createMockSandbox({ name: "eve-resource" });
    const shared = createMockSandbox({ name: "team-acme-workspace" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(shared),
        get: vi.fn().mockResolvedValue(null),
      },
    };
    const providerDependencies = dependencies(sandboxModule);

    await createVercelSandboxResource({
      context: providerContext("eve-resource"),
      dependencies: providerDependencies,
    });
    await createVercelSandboxResource({
      context: providerContext("another-eve-resource"),
      dependencies: providerDependencies,
      name: "team-acme-workspace",
    });

    expect(sandboxModule.Sandbox.create.mock.calls[0]?.[0]).toMatchObject({
      name: "eve-resource",
      persistent: true,
    });
    expect(sandboxModule.Sandbox.create.mock.calls[1]?.[0]).toMatchObject({
      name: "team-acme-workspace",
      persistent: true,
    });
  });

  it("reuses the same named Vercel sandbox across independent eve contexts", async () => {
    const shared = createMockSandbox({ name: "team-acme-workspace" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValue(shared),
        get: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(shared),
      },
    };
    const providerDependencies = dependencies(sandboxModule);

    const first = await createVercelSandboxResource({
      context: providerContext("session-one"),
      dependencies: providerDependencies,
      name: "team-acme-workspace",
    });
    const second = await createVercelSandboxResource({
      context: providerContext("session-two"),
      dependencies: providerDependencies,
      name: "team-acme-workspace",
    });

    expect(first.sandbox).toBe(shared);
    expect(second.sandbox).toBe(shared);
    expect(sandboxModule.Sandbox.create).toHaveBeenCalledOnce();
    expect(referenceVercelSandboxResource(first).name).toBe("team-acme-workspace");
    expect(referenceVercelSandboxResource(second).name).toBe("team-acme-workspace");
  });

  it("applies base setup and the authored network policy without a template", async () => {
    const sessionSandbox = createMockSandbox({ name: "session-key" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValue(sessionSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    await createVercelSandboxResource({
      context: providerContext("session-key"),
      dependencies: dependencies(sandboxModule),
      options: { networkPolicy: "deny-all" },
    });

    expect(sessionSandbox.runCommand).toHaveBeenCalledOnce();
    expect(sessionSandbox.update).toHaveBeenCalledWith({ networkPolicy: "deny-all" });
  });

  it("invalidates a template reference when its provider snapshot disappears", async () => {
    const staleTemplate = createMockSandbox({ name: "template-key" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(staleTemplate),
      },
    };
    const unavailable = Object.assign(new Error("snapshot expired"), { status: 410 });

    await expect(
      createVercelSandboxResource({
        context: providerContext("session-key"),
        dependencies: dependencies(sandboxModule, async () => {
          throw unavailable;
        }),
        template: {
          sandboxName: "template-key",
          snapshotId: "expired-snapshot",
          templateKey: "template-key",
        },
      }),
    ).rejects.toBeInstanceOf(SandboxTemplateUnavailableError);

    expect(staleTemplate.delete).toHaveBeenCalledOnce();
  });

  it("keeps the template-unavailable signal when stale template cleanup fails", async () => {
    const staleTemplate = createMockSandbox({ name: "template-key" });
    staleTemplate.delete.mockRejectedValue(new Error("transient provider failure"));
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(staleTemplate),
      },
    };
    const unavailable = Object.assign(new Error("snapshot expired"), { status: 410 });

    await expect(
      createVercelSandboxResource({
        context: providerContext("session-key"),
        dependencies: dependencies(sandboxModule, async () => {
          throw unavailable;
        }),
        template: {
          sandboxName: "template-key",
          snapshotId: "expired-snapshot",
          templateKey: "template-key",
        },
      }),
    ).rejects.toBeInstanceOf(SandboxTemplateUnavailableError);

    expect(staleTemplate.delete).toHaveBeenCalledOnce();
  });

  it("rejects more tags than the Vercel Sandbox API supports", async () => {
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    await expect(
      createVercelSandboxResource({
        context: providerContext("session-key", {
          agent: "root",
          channel: "slack",
          one: "1",
          sessionId: "session",
          two: "2",
        }),
        dependencies: dependencies(sandboxModule),
        options: { tags: { owner: "ai" } },
      }),
    ).rejects.toThrow(/at most 5 tags/);
  });
});

describe("Vercel sandbox durability", () => {
  it("restores exactly the referenced provider resource without replaying creation", async () => {
    const existing = createMockSandbox({
      createdAt: new Date("2026-07-30T12:00:00.000Z"),
      name: "persisted-sandbox",
      tags: { owner: "platform" },
    });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi.fn().mockResolvedValue(existing),
      },
    };
    const context = providerContext("eve-resource", { agent: "reviewer" });

    const resource = await restoreVercelSandboxResource(
      {
        configuration: {
          projectId: "prj_123",
          tags: { owner: "platform" },
          teamId: "team_123",
        },
        createdAt: "2026-07-30T12:00:00.000Z",
        name: "persisted-sandbox",
        sessionKey: "session-key",
      },
      context,
      dependencies(sandboxModule),
    );

    expect(resource.sandbox).toBe(existing);
    expect(resource.session.id).toBe("session-key");
    expect(sandboxModule.Sandbox.create).not.toHaveBeenCalled();
    expect(existing.update).toHaveBeenCalledWith({
      tags: {
        agent: "reviewer",
        owner: "platform",
      },
    });
  });

  it("does not accept a replacement sandbox under the persisted name", async () => {
    const replacement = createMockSandbox({
      createdAt: new Date("2026-07-30T13:00:00.000Z"),
      name: "persisted-sandbox",
    });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi.fn().mockResolvedValue(replacement),
      },
    };

    await expect(
      restoreVercelSandboxResource(
        {
          configuration: {},
          createdAt: "2026-07-30T12:00:00.000Z",
          name: "persisted-sandbox",
          sessionKey: "session-key",
        },
        providerContext("eve-resource"),
        dependencies(sandboxModule),
      ),
    ).rejects.toBeInstanceOf(SandboxResourceUnavailableError);
  });

  it("does not persist a credential token or fetch implementation", async () => {
    const sandbox = createMockSandbox({ name: "session-key" });
    const fetch = vi.fn();
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValue(sandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const resource = await createVercelSandboxResource({
      context: providerContext("session-key"),
      dependencies: dependencies(sandboxModule),
      options: {
        fetch,
        projectId: "prj_123",
        teamId: "team_123",
        token: "runtime-secret",
      } as never,
    });
    const reference = referenceVercelSandboxResource(resource);

    expect(reference.configuration).toEqual({
      projectId: "prj_123",
      teamId: "team_123",
    });
    expect(JSON.stringify(reference)).not.toContain("runtime-secret");
    expect(reference.configuration).not.toHaveProperty("fetch");
    expect(reference.configuration).not.toHaveProperty("token");
  });

  it("stops compute during shutdown without deleting the persistent resource", async () => {
    const sandbox = createMockSandbox({ name: "session-key" });
    const resource = {
      configuration: {},
      sandbox: sandbox as never,
      session: {} as never,
      sessionKey: "session-key",
    };

    await shutdownVercelSandboxResource(resource);

    expect(sandbox.stop).toHaveBeenCalledOnce();
    expect(sandbox.delete).not.toHaveBeenCalled();
  });
});

describe("Vercel sandbox session", () => {
  async function createSessionResource() {
    const sandbox = createMockSandbox({ name: "session-key" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValue(sandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };
    const resource = await createVercelSandboxResource({
      context: providerContext("session-key"),
      dependencies: dependencies(sandboxModule),
      template: {
        sandboxName: "template-key",
        snapshotId: "snapshot-frozen-at-build",
        templateKey: "template-key",
      },
    });
    return { resource, sandbox };
  }

  it("round-trips files and resolves paths from /workspace", async () => {
    const { resource } = await createSessionResource();

    await resource.session.writeTextFile({ content: "hello", path: "/workspace/message.txt" });

    await expect(resource.session.readTextFile({ path: "/workspace/message.txt" })).resolves.toBe(
      "hello",
    );
    expect(resource.session.resolvePath("python-analysis/run.py")).toBe(
      "/workspace/python-analysis/run.py",
    );
    expect(resource.session.resolvePath("/workspace/python-analysis/run.py")).toBe(
      "/workspace/python-analysis/run.py",
    );
  });

  it("forwards command environment and network policy through the provider session", async () => {
    const { resource, sandbox } = await createSessionResource();
    sandbox.runCommand.mockResolvedValue(createMockDetachedCommand() as never);
    sandbox.runCommand.mockClear();

    await resource.session.run({
      command: "printenv DEPLOY_ENV",
      env: { DEPLOY_ENV: "production" },
    });
    await resource.session.setNetworkPolicy("deny-all");

    expect(sandbox.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["-lc", "printenv DEPLOY_ENV"],
        cmd: "bash",
        cwd: "/workspace",
        detached: true,
        env: { DEPLOY_ENV: "production" },
      }),
    );
    expect(sandbox.update).toHaveBeenCalledWith({ networkPolicy: "deny-all" });
  });
});
