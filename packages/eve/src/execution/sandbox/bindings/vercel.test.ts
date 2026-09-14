import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";
import { VERCEL_EVE_SANDBOX_IMAGE } from "#execution/sandbox/bindings/eve-image.js";
import { createVercelSandbox as createVercelImplementation } from "#execution/sandbox/bindings/vercel.js";
import { createSandboxProviderHarness } from "#internal/testing/sandbox-provider-harness.js";

// The credential fallback consults the developer's Vercel CLI auth and the
// repo's `.vercel` project link; on a linked, logged-in machine it would
// inject real project credentials into the asserted SDK calls.
vi.mock("#compiled/@vercel/oidc/index.js", () => ({
  getVercelOidcToken: vi.fn(async () => {
    throw new Error("No ambient Vercel OIDC token in unit tests.");
  }),
}));

function createMockCommandResult() {
  return {
    exitCode: 0,
    stderr: vi.fn().mockResolvedValue(""),
    stdout: vi.fn().mockResolvedValue(""),
  };
}

/*
 * A detached command, as returned by `runCommand({ detached: true })`,
 * is adapted into the `Experimental_SandboxProcess` shape — the adapter
 * drains `logs()` alongside `wait()`. By default this mock yields no log
 * lines and exits 0 so `spawn` and `run` resolve without real I/O.
 */
function createMockDetachedCommand(
  logs: ReadonlyArray<{ readonly data: string; readonly stream: "stderr" | "stdout" }> = [],
) {
  return {
    kill: vi.fn().mockResolvedValue(undefined),
    logs() {
      return (async function* () {
        yield* logs;
      })();
    },
    wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
  };
}

function createMockSandbox(input: {
  name: string;
  snapshotId?: string;
  status?: string;
  tags?: Record<string, string>;
}) {
  const files = new Map<string, Buffer>();
  let tags = input.tags;
  return {
    currentSnapshotId: input.snapshotId ?? "",
    delete: vi.fn().mockResolvedValue(undefined),
    fs: {
      rm: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn().mockResolvedValue(undefined),
    },
    name: input.name,
    readFile: vi.fn(async (file: { path: string }): Promise<object | null> => {
      const content = files.get(file.path);
      return content === undefined ? null : Readable.from([content]);
    }),
    runCommand: vi
      .fn()
      .mockImplementation(async (command: { args?: readonly string[]; cmd: string }) =>
        command.cmd === "realpath"
          ? {
              ...createMockCommandResult(),
              stdout: vi.fn().mockResolvedValue(`${command.args?.at(-1) ?? ""}\n`),
            }
          : createMockCommandResult(),
      ),
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

function createVercelSandbox(input: Parameters<typeof createVercelImplementation>[0] = {}) {
  return createSandboxProviderHarness(createVercelImplementation(input), {});
}

function createTestVercelSandbox(input: Parameters<typeof createVercelImplementation>[0] = {}) {
  return createVercelSandbox({
    ...input,
    createSandbox: async ({ createOptions, sandboxModule }) =>
      await sandboxModule.Sandbox.create(createOptions),
  });
}

async function createTestVercelSession() {
  const templateSandbox = createMockSandbox({ name: "template" });
  const sessionSandbox = createMockSandbox({ name: "session" });
  const sandboxModule = {
    Sandbox: {
      create: vi.fn().mockResolvedValueOnce(templateSandbox).mockResolvedValueOnce(sessionSandbox),
      get: vi.fn().mockResolvedValue(null),
    },
  };
  const backend = createTestVercelSandbox({
    loadSandboxModule: async () => sandboxModule as never,
  });

  await backend.prepare({
    appRoot: "/tmp/test-app-root",
    seedFiles: [],
    templateName: "template-key",
  });
  const handle = await backend.getOrCreate({
    appRoot: "/tmp/test-app-root",
    sandboxName: "session-key",
    templateName: "template-key",
  });

  return { handle, sessionSandbox };
}

async function consumeWebStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) {
      return Buffer.concat(chunks).toString("utf8");
    }
    chunks.push(result.value);
  }
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

describe("createVercelSandbox", () => {
  it("creates fresh Vercel sandboxes with eve's shared base image", async () => {
    const templateSandbox = createMockSandbox({ name: "template-key" });
    const fetch = vi.fn();
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(templateSandbox),
        get: vi.fn().mockResolvedValueOnce(null),
      },
    };

    const backend = createVercelSandbox({
      createOptions: {
        fetch,
        networkPolicy: "deny-all",
        ports: [3000],
        projectId: "prj_123",
        teamId: "team_123",
        timeout: 123_000,
        token: "vercel-token",
      } as never,
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(sandboxModule.Sandbox.create).toHaveBeenCalledTimes(1);
    expect(sandboxModule.Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        image: VERCEL_EVE_SANDBOX_IMAGE,
        name: "template-key",
        networkPolicy: "allow-all",
        persistent: true,
        ports: [3000],
        projectId: "prj_123",
        teamId: "team_123",
        timeout: 123_000,
        token: "vercel-token",
      }),
    );
    expect(templateSandbox.update).toHaveBeenCalledWith({ networkPolicy: "deny-all" });
  });

  it("creates a session from the prepared snapshot artifact without looking up the template sandbox", async () => {
    const sessionSandbox = createMockSandbox({ name: "session-key" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValue(sessionSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };
    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.getOrCreate({
      appRoot: "/tmp/test-app-root",
      prepared: { snapshotId: "prepared-snapshot" },
      sandboxName: "session-key",
      templateName: "template-key",
    });

    expect(sandboxModule.Sandbox.get).toHaveBeenCalledTimes(1);
    expect(sandboxModule.Sandbox.get).toHaveBeenCalledWith(
      expect.objectContaining({ name: "session-key" }),
    );
    expect(sandboxModule.Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "session-key",
        source: { snapshotId: "prepared-snapshot", type: "snapshot" },
      }),
    );
  });

  it("uses an author-supplied image for fresh Vercel sandboxes", async () => {
    const templateSandbox = createMockSandbox({ name: "template-key" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(templateSandbox),
        get: vi.fn().mockResolvedValueOnce(null),
      },
    };

    const backend = createVercelSandbox({
      createOptions: { image: "registry.example/eve-python:1.0.0" } as never,
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });

    expect(sandboxModule.Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({ image: "registry.example/eve-python:1.0.0" }),
    );
  });

  it("forwards double-underscore create fields through Sandbox.create", async () => {
    const templateSandbox = createMockSandbox({ name: "template-key" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(templateSandbox),
        get: vi.fn().mockResolvedValueOnce(null),
      },
    };

    const backend = createVercelSandbox({
      createOptions: { __experimentalFlag: "enabled" } as never,
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });

    expect(sandboxModule.Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        __experimentalFlag: "enabled",
        image: VERCEL_EVE_SANDBOX_IMAGE,
      }),
    );
  });

  it("passes resolved credentials to Vercel sandbox lookups instead of inferring scope", async () => {
    const existingTemplate = createMockSandbox({
      name: "template-key",
      snapshotId: "template-snapshot",
    });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi.fn().mockImplementation(async (options: { token?: string }) => {
          if (options.token !== "vercel-token") {
            throw new Error('[{"path":["teams",1,"updatedAt"],"message":"Required"}]');
          }
          return existingTemplate;
        }),
      },
    };

    const backend = createTestVercelSandbox({
      createOptions: {
        projectId: "prj_123",
        teamId: "team_123",
        token: "vercel-token",
      } as never,
      loadSandboxModule: async () => sandboxModule as never,
    });

    await expect(
      backend.prepare({
        appRoot: "/tmp/test-app-root",
        seedFiles: [],
        templateName: "template-key",
      }),
    ).resolves.toMatchObject({ reused: true });

    expect(sandboxModule.Sandbox.get).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "template-key",
        projectId: "prj_123",
        resume: false,
        teamId: "team_123",
        token: "vercel-token",
      }),
    );
    expect(sandboxModule.Sandbox.create).not.toHaveBeenCalled();
  });

  it("includes Vercel SDK error response bodies in backend errors", async () => {
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi.fn().mockRejectedValue(
          Object.assign(new Error("Status code 400 is not ok"), {
            json: {
              error: {
                code: "bad_request",
                message: "The sandbox request is invalid.",
              },
            },
          }),
        ),
      },
    };

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await expect(
      backend.prepare({
        appRoot: "/tmp/test-app-root",
        seedFiles: [],
        templateName: "template-key",
      }),
    ).rejects.toThrow(/The sandbox request is invalid/);
  });

  it("resolves symlinked destinations before writing files", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    vi.mocked(sessionSandbox.runCommand).mockResolvedValueOnce({
      ...createMockCommandResult(),
      stdout: vi.fn().mockResolvedValue("/workspace/repository/agent/instructions.md\n"),
    });

    await handle.sandbox.writeTextFile({
      content: "updated instructions\n",
      path: "/source/instructions.md",
    });

    expect(sessionSandbox.runCommand).toHaveBeenLastCalledWith({
      args: ["-m", "--", "/source/instructions.md"],
      cmd: "realpath",
      signal: undefined,
    });
    expect(sessionSandbox.writeFiles).toHaveBeenLastCalledWith(
      [
        {
          content: Buffer.from("updated instructions\n"),
          path: "/workspace/repository/agent/instructions.md",
        },
      ],
      { signal: undefined },
    );
  });

  it("resolves and writes all seed paths to the sandbox filesystem in one batch", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    vi.mocked(templateSandbox.runCommand).mockImplementation(
      async (options: { readonly detached?: boolean }) =>
        options.detached === true
          ? (createMockDetachedCommand([
              { data: "/home/vercel-sandbox\n", stream: "stdout" },
            ]) as never)
          : createMockCommandResult(),
    );
    const sandboxModule = {
      Sandbox: {
        create: vi
          .fn()
          .mockResolvedValueOnce(templateSandbox)
          .mockResolvedValueOnce(sessionSandbox),
        get: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(templateSandbox)
          .mockResolvedValueOnce(null),
      },
    };

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [
        {
          content: "skill body",
          path: "/workspace/skills/weather/SKILL.md",
        },
        {
          content: Buffer.from([0, 1, 2, 3]),
          path: "/workspace/assets/fixture.bin",
        },
        {
          content: "model skill body",
          path: "$HOME/.agents/skills/research/SKILL.md",
        },
      ],
      templateName: "template-key",
    });

    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });

    await backend.getOrCreate({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
      templateName: "template-key",
    });

    expect(templateSandbox.writeFiles).toHaveBeenCalledTimes(1);

    const files = vi.mocked(templateSandbox.writeFiles).mock.calls[0]?.[0];
    expect(files?.map((file) => file.path)).toEqual([
      "/workspace/skills/weather/SKILL.md",
      "/workspace/assets/fixture.bin",
      "/home/vercel-sandbox/.agents/skills/research/SKILL.md",
    ]);
    expect(files?.[0]?.content).toEqual(Buffer.from("skill body"));
    expect(files?.[1]?.content).toEqual(Buffer.from([0, 1, 2, 3]));
    expect(files?.[2]?.content).toEqual(Buffer.from("model skill body"));
  });

  it("writes seed files before preparation and snapshots preparation outputs", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(templateSandbox),
        get: vi.fn().mockResolvedValueOnce(null),
      },
    };
    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.prepare({
      runPreparation: async (sandbox) => {
        await expect(sandbox.readTextFile({ path: "/workspace/seed.txt" })).resolves.toBe(
          "authored seed",
        );
        await sandbox.writeTextFile({
          content: "bootstrap output",
          path: "/workspace/bootstrap.txt",
        });
      },
      appRoot: "/tmp/test-app-root",
      seedFiles: [
        { content: "authored seed", path: "/workspace/seed.txt" },
        { content: "second seed", path: "/workspace/second.txt" },
      ],
      templateName: "template-key",
    });

    const writes = vi.mocked(templateSandbox.writeFiles);
    expect(writes).toHaveBeenCalledTimes(2);
    expect(writes.mock.calls[0]?.[0].map((file) => file.path)).toEqual([
      "/workspace/seed.txt",
      "/workspace/second.txt",
    ]);
    expect(writes.mock.calls[1]?.[0].map((file) => file.path)).toEqual([
      "/workspace/bootstrap.txt",
    ]);
    expect(writes.mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(templateSandbox.snapshot).mock.invocationCallOrder[0]!,
    );
  });

  it("reports a fresh build when no framework snapshot exists yet", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(templateSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    const result = await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });

    expect(result).toMatchObject({ reused: false });
    expect(templateSandbox.snapshot).toHaveBeenCalledTimes(1);
  });

  it("recreates a stale stopped Vercel template that has no snapshot", async () => {
    const staleTemplate = createMockSandbox({
      name: "template-key",
      status: "stopped",
    });
    const freshTemplate = createMockSandbox({ name: "template-key" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(freshTemplate),
        get: vi.fn().mockResolvedValueOnce(staleTemplate),
      },
    };

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    const result = await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });

    expect(result).toMatchObject({ reused: false });
    expect(staleTemplate.delete).toHaveBeenCalledTimes(1);
    expect(staleTemplate.runCommand).not.toHaveBeenCalled();
    expect(sandboxModule.Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "template-key",
        persistent: true,
      }),
    );
    expect(freshTemplate.snapshot).toHaveBeenCalledTimes(1);
  });

  it("reports a reuse when an existing template already carries a framework snapshot", async () => {
    const existingTemplate = createMockSandbox({
      name: "template-key",
      snapshotId: "framework-snapshot",
    });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi.fn().mockResolvedValue(existingTemplate),
      },
    };

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    const result = await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });

    expect(result).toMatchObject({ reused: true });
    // Reuse must not re-snapshot or re-create the template sandbox.
    expect(existingTemplate.snapshot).not.toHaveBeenCalled();
    expect(sandboxModule.Sandbox.create).not.toHaveBeenCalled();
  });

  it("removes paths through the sandbox filesystem API", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const sandboxModule = {
      Sandbox: {
        create: vi
          .fn()
          .mockResolvedValueOnce(templateSandbox)
          .mockResolvedValueOnce(sessionSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });
    const handle = await backend.getOrCreate({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
      templateName: "template-key",
    });
    vi.mocked(sessionSandbox.runCommand).mockClear();

    await handle.sandbox.removePath({ force: true, path: "skills/tenant", recursive: true });

    expect(sessionSandbox.fs.rm).toHaveBeenCalledWith("/workspace/skills/tenant", {
      force: true,
      recursive: true,
      signal: undefined,
    });
    expect(sessionSandbox.runCommand).not.toHaveBeenCalled();
  });

  it("applies a 30-minute default timeout to Sandbox.create", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const create = vi
      .fn()
      .mockResolvedValueOnce(templateSandbox)
      .mockResolvedValueOnce(sessionSandbox);
    const sandboxModule = {
      Sandbox: {
        create,
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });

    await backend.getOrCreate({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
      templateName: "template-key",
    });

    expect(create).toHaveBeenCalledTimes(2);
    const [templateArgs, sessionArgs] = create.mock.calls;
    expect(templateArgs?.[0]).toMatchObject({ timeout: 30 * 60 * 1_000 });
    expect(sessionArgs?.[0]).toMatchObject({ timeout: 30 * 60 * 1_000 });
  });

  it("applies framework defaults to Sandbox.create when no createOptions are supplied", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const create = vi
      .fn()
      .mockResolvedValueOnce(templateSandbox)
      .mockResolvedValueOnce(sessionSandbox);
    const sandboxModule = {
      Sandbox: {
        create,
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });

    await backend.getOrCreate({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
      templateName: "template-key",
    });

    expect(create).toHaveBeenCalledTimes(2);
    const [templateArgs, sessionArgs] = create.mock.calls;
    expect(templateArgs?.[0]).toMatchObject({
      name: "template-key",
      persistent: true,
      timeout: 30 * 60 * 1_000,
    });
    expect(sessionArgs?.[0]).toMatchObject({
      name: "session-key",
      persistent: true,
      timeout: 30 * 60 * 1_000,
      source: { snapshotId: "template-snapshot", type: "snapshot" },
    });
  });

  it("creates a fresh session without reading or snapshotting a template when templateKey is null", async () => {
    const sessionSandbox = createMockSandbox({ name: "session" });
    const create = vi.fn().mockResolvedValueOnce(sessionSandbox);
    const get = vi.fn().mockResolvedValue(null);
    const sandboxModule = {
      Sandbox: {
        create,
        get,
      },
    };

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.getOrCreate({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
      templateName: null,
    });

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith({
      fetch: expect.any(Function),
      name: "session-key",
      resume: false,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      name: "session-key",
      persistent: true,
      timeout: 30 * 60 * 1_000,
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("source");
    expect(sessionSandbox.snapshot).not.toHaveBeenCalled();
  });

  it("keeps author createOptions on template-less fresh sessions", async () => {
    const sessionSandbox = createMockSandbox({ name: "session" });
    const create = vi.fn().mockResolvedValueOnce(sessionSandbox);
    const sandboxModule = {
      Sandbox: {
        create,
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const backend = createTestVercelSandbox({
      createOptions: {
        ports: [3000],
        source: { snapshotId: "author-snap", type: "snapshot" },
      },
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.getOrCreate({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
      templateName: null,
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      name: "session-key",
      persistent: true,
      ports: [3000],
      source: { snapshotId: "author-snap", type: "snapshot" },
    });
    expect(sessionSandbox.snapshot).not.toHaveBeenCalled();
  });

  it("forwards factory createOptions to both template and session Sandbox.create", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const create = vi
      .fn()
      .mockResolvedValueOnce(templateSandbox)
      .mockResolvedValueOnce(sessionSandbox);
    const sandboxModule = {
      Sandbox: {
        create,
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const backend = createTestVercelSandbox({
      createOptions: {
        networkPolicy: "deny-all",
        ports: [3000, 4000],
        resources: { vcpus: 2 },
        timeout: 600_000,
      },
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });

    await backend.getOrCreate({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
      templateName: "template-key",
    });

    expect(create).toHaveBeenCalledTimes(2);
    const [templateArgs, sessionArgs] = create.mock.calls;
    expect(templateArgs?.[0]).toMatchObject({
      name: "template-key",
      networkPolicy: "allow-all",
      persistent: true,
      ports: [3000, 4000],
      resources: { vcpus: 2 },
      timeout: 600_000,
    });
    expect(sessionArgs?.[0]).toMatchObject({
      name: "session-key",
      networkPolicy: "deny-all",
      persistent: true,
      ports: [3000, 4000],
      resources: { vcpus: 2 },
      source: { snapshotId: "template-snapshot", type: "snapshot" },
      timeout: 600_000,
    });
    expect(templateSandbox.update).toHaveBeenCalledWith({ networkPolicy: "deny-all" });
  });

  it("applies mounts passed directly to getOrCreate", async () => {
    const sessionSandbox = createMockSandbox({ name: "session" });
    const create = vi.fn().mockResolvedValue(sessionSandbox);
    const provider = createSandboxProviderHarness(
      createVercelImplementation({
        loadSandboxModule: async () =>
          ({ Sandbox: { create, get: vi.fn().mockResolvedValue(null) } }) as never,
      }),
      { mounts: { "/workspace/repos": { drive: "team-drive", mode: "read-write" } } },
    );
    await provider.getOrCreate({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
      templateName: null,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        mounts: { "/workspace/repos": { drive: "team-drive", mode: "read-write" } },
      }),
    );
  });

  it("forwards author source to template create as the base layer", async () => {
    /*
     * The real Vercel SDK pre-populates `currentSnapshotId` on a
     * freshly-created sandbox when the create call passed a snapshot
     * source. The template sandbox mock mirrors that — if eve's
     * "template already has a snapshot, reuse it" guard fires on a
     * newly-created template, it returns the author's snapshotId
     * instead of running bootstrap/seed/`sandbox.snapshot()`, so the
     * session would derive directly from the author snapshot and the
     * framework's setup would never run. That's the regression this
     * test pins.
     */
    const templateSandbox = createMockSandbox({
      name: "template",
      snapshotId: "author-snap",
    });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const create = vi
      .fn()
      .mockResolvedValueOnce(templateSandbox)
      .mockResolvedValueOnce(sessionSandbox);
    const sandboxModule = {
      Sandbox: {
        create,
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const backend = createTestVercelSandbox({
      createOptions: { source: { snapshotId: "author-snap", type: "snapshot" } },
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });

    await backend.getOrCreate({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
      templateName: "template-key",
    });

    expect(create).toHaveBeenCalledTimes(2);
    const [templateArgs, sessionArgs] = create.mock.calls;
    expect(templateArgs?.[0]).toMatchObject({
      source: { snapshotId: "author-snap", type: "snapshot" },
    });
    expect(templateSandbox.snapshot).toHaveBeenCalledTimes(1);
    expect(sessionArgs?.[0]).toMatchObject({
      source: { snapshotId: "template-snapshot", type: "snapshot" },
    });
  });

  it("re-runs prewarm when an existing template still carries the author snapshot as its currentSnapshotId", async () => {
    /*
     * A previous prewarm that crashed (or just never reached
     * `sandbox.snapshot()`) leaves a named template sandbox in the
     * project whose `currentSnapshotId` is still the author's source
     * snapshot. Without explicit handling, `getNamedSandbox` would
     * find it and eve would treat the author's snapshot as the
     * framework's prewarmed snapshot, skipping setup/bootstrap/seeds
     * forever. This test pins that we ignore that exact value and
     * proceed with prewarm on the existing sandbox.
     */
    const existingTemplate = createMockSandbox({
      name: "template-key",
      snapshotId: "author-snap",
    });
    const sessionSandbox = createMockSandbox({ name: "session-key" });
    const create = vi.fn().mockResolvedValueOnce(sessionSandbox);
    const get = vi.fn().mockImplementation(async ({ name }: { name: string }) => {
      if (name === "template-key") return existingTemplate;
      if (name === "session-key") return null;
      return null;
    });
    const sandboxModule = { Sandbox: { create, get } };

    const backend = createTestVercelSandbox({
      createOptions: { source: { snapshotId: "author-snap", type: "snapshot" } },
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });

    await backend.getOrCreate({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
      templateName: "template-key",
    });

    expect(existingTemplate.snapshot).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      source: { snapshotId: "template-key-snapshot", type: "snapshot" },
    });
  });

  it("invalidates and rebuilds a Vercel template when its snapshot expired before session create", async () => {
    const staleTemplate = createMockSandbox({
      name: "template-key",
      snapshotId: "expired-template-snapshot",
    });
    const freshTemplate = createMockSandbox({ name: "template-key" });
    const sessionSandbox = createMockSandbox({ name: "session-key" });
    let templateDeleted = false;
    vi.mocked(staleTemplate.delete).mockImplementation(async () => {
      templateDeleted = true;
    });

    const snapshotExpiredError = Object.assign(
      new Error("Vercel sandbox create API returned 410"),
      {
        json: {
          error: {
            code: "bad_request",
            message: "Resource is gone.",
          },
        },
        response: { status: 410 },
      },
    );
    const create = vi
      .fn()
      .mockRejectedValueOnce(snapshotExpiredError)
      .mockResolvedValueOnce(freshTemplate)
      .mockResolvedValueOnce(sessionSandbox);
    const get = vi.fn().mockImplementation(async ({ name }: { name: string }) => {
      if (name === "template-key") {
        return templateDeleted ? null : staleTemplate;
      }
      if (name === "session-key") {
        return null;
      }
      return null;
    });
    const sandboxModule = { Sandbox: { create, get } };

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await expect(
      backend.getOrCreate({
        appRoot: "/tmp/test-app-root",
        prepared: { snapshotId: "expired-template-snapshot" },
        sandboxName: "session-key",
        templateName: "template-key",
      }),
    ).rejects.toBeInstanceOf(SandboxTemplateNotProvisionedError);
    expect(staleTemplate.delete).not.toHaveBeenCalled();

    const prewarmResult = await backend.prepare({
      appRoot: "/tmp/test-app-root",
      force: true,
      seedFiles: [],
      templateName: "template-key",
    });
    await backend.getOrCreate({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
      templateName: "template-key",
    });

    expect(prewarmResult).toMatchObject({ reused: false });
    expect(freshTemplate.snapshot).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      name: "session-key",
      source: { snapshotId: "expired-template-snapshot", type: "snapshot" },
    });
    expect(create.mock.calls[1]?.[0]).toMatchObject({
      name: "template-key",
      persistent: true,
    });
    expect(create.mock.calls[2]?.[0]).toMatchObject({
      name: "session-key",
      source: { snapshotId: "template-key-snapshot", type: "snapshot" },
    });
  });

  it("does not invalidate the shared template when a fresh session initialization returns 410", async () => {
    const templateSandbox = createMockSandbox({
      name: "template-key",
      snapshotId: "template-snapshot",
    });
    const freshSession = createMockSandbox({ name: "session-key" });
    const snapshotUnavailableError = Object.assign(new Error("Cannot initialize sandbox"), {
      response: { status: 410 },
    });
    vi.mocked(freshSession.runCommand).mockRejectedValueOnce(snapshotUnavailableError);
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(freshSession),
        get: vi.fn().mockImplementation(async ({ name }: { name: string }) => {
          if (name === "template-key") return templateSandbox;
          return null;
        }),
      },
    };
    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await expect(
      backend.getOrCreate({
        appRoot: "/tmp/test-app-root",
        prepared: { snapshotId: "template-snapshot" },
        sandboxName: "session-key",
        templateName: "template-key",
      }),
    ).rejects.toThrow('Failed to initialize sandbox session "session-key"');

    expect(templateSandbox.delete).not.toHaveBeenCalled();
  });

  it("does not invalidate the shared template for an ambiguous session-create 404", async () => {
    const templateSandbox = createMockSandbox({
      name: "template-key",
      snapshotId: "template-snapshot",
    });
    const imageNotFoundError = Object.assign(new Error("Image not found"), {
      response: { status: 404 },
    });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockRejectedValueOnce(imageNotFoundError),
        get: vi.fn().mockImplementation(async ({ name }: { name: string }) => {
          if (name === "template-key") return templateSandbox;
          return null;
        }),
      },
    };
    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await expect(
      backend.getOrCreate({
        appRoot: "/tmp/test-app-root",
        prepared: { snapshotId: "template-snapshot" },
        sandboxName: "session-key",
        templateName: "template-key",
      }),
    ).rejects.toThrow('Failed to create sandbox session "session-key": Image not found');

    expect(templateSandbox.delete).not.toHaveBeenCalled();
  });

  it("rebuilds a Vercel template when the named sandbox disappears during prewarm", async () => {
    const staleTemplate = createMockSandbox({ name: "template-key" });
    const freshTemplate = createMockSandbox({ name: "template-key" });
    const missingTemplateError = Object.assign(new Error("Status code 404 is not ok"), {
      response: { status: 404 },
    });
    vi.mocked(staleTemplate.snapshot).mockRejectedValueOnce(missingTemplateError);

    const create = vi
      .fn()
      .mockResolvedValueOnce(staleTemplate)
      .mockResolvedValueOnce(freshTemplate);
    const sandboxModule = {
      Sandbox: {
        create,
        get: vi.fn().mockResolvedValue(null),
      },
    };
    const log = vi.fn();

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await expect(
      backend.prepare({
        log,
        appRoot: "/tmp/test-app-root",
        seedFiles: [],
        templateName: "template-key",
      }),
    ).resolves.toMatchObject({ reused: false });

    expect(create).toHaveBeenCalledTimes(2);
    expect(staleTemplate.snapshot).toHaveBeenCalledTimes(1);
    expect(freshTemplate.snapshot).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("cached template disappeared; rebuilding sandbox template");
  });

  it("resumes a stopped session sandbox via Sandbox.get instead of creating a new one", async () => {
    const templateSandbox = createMockSandbox({
      name: "template-key",
      snapshotId: "template-snapshot",
    });
    const sessionSandbox = createMockSandbox({ name: "persisted-sandbox-name" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi.fn().mockImplementation(async ({ name }: { name: string }) => {
          if (name === "template-key") return templateSandbox;
          if (name === "persisted-sandbox-name") return sessionSandbox;
          return null;
        }),
      },
    };

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });

    const handle = await backend.getOrCreate({
      existing: { sandboxName: "persisted-sandbox-name" },
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
      templateName: "template-key",
    });

    expect(sandboxModule.Sandbox.create).not.toHaveBeenCalled();
    expect(sandboxModule.Sandbox.get).toHaveBeenCalledWith({
      fetch: expect.any(Function),
      name: "persisted-sandbox-name",
      resume: false,
    });
    expect(sessionSandbox.runCommand).toHaveBeenCalledTimes(1);
    expect(sessionSandbox.runCommand).toHaveBeenCalledWith({
      args: ["-lc", expect.stringContaining("ln -s /proc/self/fd /dev/fd")],
      cmd: "bash",
    });
    expect(handle.sandbox).toBeDefined();

    const state = handle.metadata;
    expect(state).toEqual({ sandboxName: "persisted-sandbox-name" });
  });

  it("replaces a persisted session whose snapshot is unavailable", async () => {
    const templateSandbox = createMockSandbox({
      name: "template-key",
      snapshotId: "template-snapshot",
    });
    const staleSession = createMockSandbox({ name: "persisted-sandbox-name", status: "stopped" });
    const replacementSession = createMockSandbox({ name: "session-key" });
    const snapshotUnavailableError = Object.assign(new Error("Cannot resume sandbox"), {
      response: { status: 410 },
    });
    vi.mocked(staleSession.runCommand).mockRejectedValueOnce(snapshotUnavailableError);

    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(replacementSession),
        get: vi.fn().mockImplementation(async ({ name }: { name: string }) => {
          if (name === "template-key") return templateSandbox;
          if (name === "persisted-sandbox-name") return staleSession;
          if (name === "session-key") return null;
          return null;
        }),
      },
    };
    const stableDelete = vi.fn().mockResolvedValue(undefined);
    const stableGet = vi.fn().mockResolvedValue({ delete: stableDelete });
    const backend = createTestVercelSandbox({
      loadDeleteSandboxModule: async () => ({ Sandbox: { get: stableGet } }) as never,
      loadSandboxModule: async () => sandboxModule as never,
    });

    const handle = await backend.getOrCreate({
      existing: { sandboxName: "persisted-sandbox-name" },
      appRoot: "/tmp/test-app-root",
      prepared: { snapshotId: "template-snapshot" },
      sandboxName: "session-key",
      templateName: "template-key",
    });

    expect(staleSession.delete).not.toHaveBeenCalled();
    expect(stableGet).toHaveBeenCalledWith({
      fetch: expect.any(Function),
      name: "persisted-sandbox-name",
      resume: false,
      signal: undefined,
    });
    expect(stableDelete).toHaveBeenCalledWith({
      deleteOrphanSnapshots: true,
      signal: undefined,
    });
    expect(templateSandbox.delete).not.toHaveBeenCalled();
    expect(sandboxModule.Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "session-key",
        persistent: true,
        source: { snapshotId: "template-snapshot", type: "snapshot" },
      }),
    );
    expect(handle.metadata).toEqual({ sandboxName: "session-key" });
  });

  it("stops the session sandbox on shutdown so no VM outlives the server", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();

    await handle.shutdown();

    expect(sessionSandbox.stop).toHaveBeenCalledTimes(1);
  });

  it("stops authored compute and keeps the Vercel session handle usable", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    vi.mocked(sessionSandbox.runCommand).mockResolvedValue(createMockDetachedCommand() as never);
    vi.mocked(sessionSandbox.runCommand).mockClear();

    await handle.stop();
    await handle.sandbox.run({ command: "printf resumed" });

    expect(sessionSandbox.stop).toHaveBeenCalledTimes(1);
    expect(sessionSandbox.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["-lc", "printf resumed"], cmd: "bash" }),
    );
  });

  it("asks Vercel to delete orphan snapshots when deleting the sandbox", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const order: string[] = [];
    sessionSandbox.stop.mockImplementation(async () => {
      order.push("stop");
    });
    const stableDelete = vi.fn(async () => {
      order.push("sandbox-delete");
    });
    const stableGet = vi.fn(async () => {
      order.push("sandbox-get");
      return { delete: stableDelete };
    });
    const sandboxModule = {
      Sandbox: {
        create: vi
          .fn()
          .mockResolvedValueOnce(templateSandbox)
          .mockResolvedValueOnce(sessionSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };
    const backend = createTestVercelSandbox({
      loadDeleteSandboxModule: async () => ({ Sandbox: { get: stableGet } }) as never,
      loadSandboxModule: async () => sandboxModule as never,
    });
    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });
    const handle = await backend.getOrCreate({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
      templateName: "template-key",
    });
    const abortSignal = new AbortController().signal;

    await expect(handle.delete({ abortSignal })).resolves.toBeUndefined();

    expect(order).toEqual(["stop", "sandbox-get", "sandbox-delete"]);
    expect(stableGet).toHaveBeenCalledWith({
      fetch: expect.any(Function),
      name: "session",
      resume: false,
      signal: abortSignal,
    });
    expect(stableDelete).toHaveBeenCalledWith({
      deleteOrphanSnapshots: true,
      signal: abortSignal,
    });
  });

  it("skips the stop call on shutdown when the sandbox is not running", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session", status: "stopped" });
    const sandboxModule = {
      Sandbox: {
        create: vi
          .fn()
          .mockResolvedValueOnce(templateSandbox)
          .mockResolvedValueOnce(sessionSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };
    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });
    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });
    const handle = await backend.getOrCreate({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
      templateName: "template-key",
    });

    await handle.shutdown();

    expect(sessionSandbox.stop).not.toHaveBeenCalled();
  });

  it("surfaces an authored session stop failure", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    sessionSandbox.stop.mockRejectedValueOnce(new Error("provider unreachable"));

    await expect(handle.stop()).rejects.toThrow("provider unreachable");
  });

  it("falls back to creating a new session when the persisted sandbox no longer exists", async () => {
    const templateSandbox = createMockSandbox({
      name: "template-key",
      snapshotId: "template-snapshot",
    });
    const newSessionSandbox = createMockSandbox({ name: "session-key" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(newSessionSandbox),
        get: vi.fn().mockImplementation(async ({ name }: { name: string }) => {
          if (name === "template-key") return templateSandbox;
          throw Object.assign(new Error("Not found"), {
            response: { status: 404 },
          });
        }),
      },
    };

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });

    const handle = await backend.getOrCreate({
      existing: { sandboxName: "deleted-sandbox" },
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
      templateName: "template-key",
    });

    expect(sandboxModule.Sandbox.get).toHaveBeenCalledWith({
      fetch: expect.any(Function),
      name: "deleted-sandbox",
      resume: false,
    });
    expect(sandboxModule.Sandbox.create).toHaveBeenCalledTimes(1);
    expect(sandboxModule.Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "deleted-sandbox",
        persistent: true,
        source: { snapshotId: "template-snapshot", type: "snapshot" },
      }),
    );
    expect(handle.sandbox).toBeDefined();
  });

  it("does not call Sandbox.create on resume and does not re-apply factory createOptions", async () => {
    const templateSandbox = createMockSandbox({
      name: "template-key",
      snapshotId: "template-snapshot",
    });
    const sessionSandbox = createMockSandbox({ name: "session-key" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi.fn().mockImplementation(async ({ name }: { name: string }) => {
          if (name === "template-key") return templateSandbox;
          if (name === "session-key") return sessionSandbox;
          return null;
        }),
      },
    };

    const backend = createTestVercelSandbox({
      createOptions: { networkPolicy: "deny-all" },
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });

    await backend.getOrCreate({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
      templateName: "template-key",
    });

    expect(sandboxModule.Sandbox.create).not.toHaveBeenCalled();
    // The factory's networkPolicy must NOT leak into a sandbox.update on resume.
    const updateCalls = vi.mocked(sessionSandbox.update).mock.calls;
    for (const call of updateCalls) {
      expect(call[0]).not.toHaveProperty("networkPolicy");
    }
  });

  it("adds eve sandbox tags to Vercel template and session creation", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const create = vi
      .fn()
      .mockResolvedValueOnce(templateSandbox)
      .mockResolvedValueOnce(sessionSandbox);
    const sandboxModule = {
      Sandbox: {
        create,
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });

    await backend.getOrCreate({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
      tags: {
        agent: "weather-agent",
        channel: "slack",
        sessionId: "session_123",
      },
      templateName: "template-key",
    });

    expect(create).toHaveBeenCalledTimes(2);
    const [templateArgs, sessionArgs] = create.mock.calls;
    expect(templateArgs?.[0]).toMatchObject({
      name: "template-key",
      persistent: true,
    });
    expect(sessionArgs?.[0]).toMatchObject({
      name: "session-key",
      persistent: true,
      tags: {
        agent: "weather-agent",
        channel: "slack",
        sessionId: "session_123",
      },
    });
  });

  it("brokers credentials through the session's setNetworkPolicy to sandbox.update", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const sandboxModule = {
      Sandbox: {
        create: vi
          .fn()
          .mockResolvedValueOnce(templateSandbox)
          .mockResolvedValueOnce(sessionSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });

    const handle = await backend.getOrCreate({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
      templateName: "template-key",
    });

    await handle.sandbox.setNetworkPolicy({
      allow: {
        "github.com": [{ transform: [{ headers: { authorization: "Basic eC1hY2Nlc3M=" } }] }],
        "*": [],
      },
    });

    expect(sessionSandbox.update).toHaveBeenCalledTimes(1);
    expect(sessionSandbox.update).toHaveBeenCalledWith({
      networkPolicy: {
        allow: {
          "github.com": [{ transform: [{ headers: { authorization: "Basic eC1hY2Nlc3M=" } }] }],
          "*": [],
        },
      },
    });
  });

  it("does not call sandbox.update when preparation() is invoked without options", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(templateSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.prepare({
      runPreparation: async () => {},
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });

    expect(templateSandbox.update).not.toHaveBeenCalled();
    expect(templateSandbox.snapshot).toHaveBeenCalledTimes(1);
  });

  it("rejects conflicting configuration for an existing named sandbox", async () => {
    const sessionSandbox = createMockSandbox({
      name: "session-key",
      tags: { sandboxConfig: "old" },
    });
    const backend = createTestVercelSandbox({
      loadSandboxModule: async () =>
        ({
          Sandbox: {
            create: vi.fn(),
            get: vi.fn().mockResolvedValue(sessionSandbox),
          },
        }) as never,
    });

    await expect(
      backend.getOrCreate({
        appRoot: "/tmp/test-app-root",
        sandboxName: "session-key",
        tags: { sandboxConfig: "new" },
        templateName: null,
      }),
    ).rejects.toThrow("conflicting configuration");
  });

  it("updates tags when reattaching existing Vercel sandboxes", async () => {
    const templateSandbox = createMockSandbox({
      name: "template-key",
      snapshotId: "template-snapshot",
      tags: { agent: "old-agent" },
    });
    const sessionSandbox = createMockSandbox({
      name: "session-key",
      tags: { agent: "old-agent" },
    });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi.fn().mockImplementation(async ({ name }: { name: string }) => {
          if (name === "template-key") {
            return templateSandbox;
          }
          if (name === "session-key") {
            return sessionSandbox;
          }
          return null;
        }),
      },
    };

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });

    await backend.getOrCreate({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
      tags: {
        agent: "weather-agent",
        channel: "slack",
        sessionId: "session_123",
      },
      templateName: "template-key",
    });

    expect(sandboxModule.Sandbox.create).not.toHaveBeenCalled();
    expect(sessionSandbox.update).toHaveBeenCalledWith({
      tags: {
        agent: "weather-agent",
        channel: "slack",
        sessionId: "session_123",
      },
    });
  });

  it("rejects merged Vercel sandbox tags over the platform limit", async () => {
    const sandboxModule = {
      Sandbox: {
        create: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await expect(
      backend.getOrCreate({
        appRoot: "/tmp/test-app-root",
        prepared: { snapshotId: "template-snapshot" },
        sandboxName: "session-key",
        tags: {
          agent: "weather-agent",
          channel: "slack",
          env: "test",
          owner: "ai",
          sessionId: "session_123",
          team: "infra",
        },
        templateName: "template-key",
      }),
    ).rejects.toThrow(/supports at most 5 tags/);
    expect(sandboxModule.Sandbox.create).not.toHaveBeenCalled();
  });

  it("exposes /workspace-rooted resolved paths through the public session", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const sandboxModule = {
      Sandbox: {
        create: vi
          .fn()
          .mockResolvedValueOnce(templateSandbox)
          .mockResolvedValueOnce(sessionSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });

    const handle = await backend.getOrCreate({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
      templateName: "template-key",
    });

    expect(handle.sandbox.resolvePath("/workspace/python-analysis/run.py")).toBe(
      "/workspace/python-analysis/run.py",
    );
    expect(handle.sandbox.resolvePath("python-analysis/run.py")).toBe(
      "/workspace/python-analysis/run.py",
    );
  });

  it("converts Vercel Node file streams to the public Web stream contract", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    sessionSandbox.readFile.mockResolvedValueOnce(
      Readable.from([Buffer.from("hello "), Buffer.from("sandbox")]),
    );

    const stream = await handle.sandbox.readFile({ path: "/workspace/message.txt" });

    expect(stream).not.toBeNull();
    expect(await consumeWebStream(stream!)).toBe("hello sandbox");
    expect(sessionSandbox.readFile).toHaveBeenCalledWith({ path: "/workspace/message.txt" });
  });

  it("passes existing Web file streams through unchanged", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    const providerStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("web stream"));
        controller.close();
      },
    });
    sessionSandbox.readFile.mockResolvedValueOnce(providerStream);

    const stream = await handle.sandbox.readFile({ path: "/workspace/message.txt" });

    expect(stream).toBe(providerStream);
    expect(await consumeWebStream(stream!)).toBe("web stream");
  });

  it("preserves missing Vercel files as null", async () => {
    const { handle } = await createTestVercelSession();

    await expect(handle.sandbox.readFile({ path: "/workspace/missing.txt" })).resolves.toBeNull();
  });

  it("propagates Vercel file-read errors unchanged", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    const providerError = new Error("provider read failed");
    sessionSandbox.readFile.mockRejectedValueOnce(providerError);

    await expect(handle.sandbox.readFile({ path: "/workspace/message.txt" })).rejects.toBe(
      providerError,
    );
  });

  it("rejects unsupported Vercel file-stream values", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    sessionSandbox.readFile.mockResolvedValueOnce({ readable: true });

    await expect(handle.sandbox.readFile({ path: "/workspace/message.txt" })).rejects.toThrow(
      "Vercel Sandbox returned an unsupported file stream.",
    );
  });

  it("forwards env to runCommand when spawning a process", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const sandboxModule = {
      Sandbox: {
        create: vi
          .fn()
          .mockResolvedValueOnce(templateSandbox)
          .mockResolvedValueOnce(sessionSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });
    const handle = await backend.getOrCreate({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
      templateName: "template-key",
    });

    vi.mocked(sessionSandbox.runCommand).mockResolvedValue(createMockDetachedCommand() as never);
    vi.mocked(sessionSandbox.runCommand).mockClear();

    await handle.sandbox.spawn({
      command: "printenv DEPLOY_ENV",
      env: { DEPLOY_ENV: "staging" },
    });

    expect(sessionSandbox.runCommand).toHaveBeenCalledTimes(1);
    expect(sessionSandbox.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["-lc", "printenv DEPLOY_ENV"],
        cmd: "bash",
        env: { DEPLOY_ENV: "staging" },
      }),
    );
  });

  it("forwards env to runCommand when running a command", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const sandboxModule = {
      Sandbox: {
        create: vi
          .fn()
          .mockResolvedValueOnce(templateSandbox)
          .mockResolvedValueOnce(sessionSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });
    const handle = await backend.getOrCreate({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
      templateName: "template-key",
    });

    vi.mocked(sessionSandbox.runCommand).mockResolvedValue(createMockDetachedCommand() as never);
    vi.mocked(sessionSandbox.runCommand).mockClear();

    await handle.sandbox.run({
      command: "printenv DEPLOY_ENV",
      env: { DEPLOY_ENV: "production" },
    });

    expect(sessionSandbox.runCommand).toHaveBeenCalledTimes(1);
    expect(sessionSandbox.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["-lc", "printenv DEPLOY_ENV"],
        cmd: "bash",
        env: { DEPLOY_ENV: "production" },
      }),
    );
  });

  it("exposes a stable backend name", () => {
    const backend = createTestVercelSandbox();
    expect(backend).toBeDefined();
  });

  it("prepares the base runtime during sandbox init", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const sandboxModule = {
      Sandbox: {
        create: vi
          .fn()
          .mockResolvedValueOnce(templateSandbox)
          .mockResolvedValueOnce(sessionSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });

    await backend.getOrCreate({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
      templateName: "template-key",
    });

    for (const sandbox of [templateSandbox, sessionSandbox]) {
      const calls = vi.mocked(sandbox.runCommand).mock.calls;
      expect(calls).toHaveLength(1);

      const setupCall = calls[0]?.[0] as {
        args?: string[];
        cmd?: string;
        sudo?: boolean;
      };
      expect(setupCall).toMatchObject({ cmd: "bash" });
      expect(setupCall.sudo).toBeUndefined();
      const setupScript = setupCall.args?.[1] ?? "";
      expect(setupScript).toContain("mkdir -p /workspace");
      expect(setupScript).toContain("command -v bash");
      expect(setupScript).toContain("ln -s /proc/self/fd /dev/fd");
      expect(setupScript).toContain("test /dev/fd -ef /proc/self/fd");
      expect(setupScript).not.toContain("apt-get");
      expect(setupScript).not.toContain("gpgv");
      expect(setupScript).not.toContain("node --version");
      expect(setupScript).not.toContain("npm");
      expect(setupScript).not.toContain("python3");
      expect(setupScript).not.toContain("ripgrep");
      expect(setupScript).not.toContain("sudo mkdir");
      expect(setupScript).not.toContain("chown");
    }
  });

  it("retries base runtime setup through sudo when the default user fails", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    vi.mocked(templateSandbox.runCommand)
      .mockResolvedValueOnce({
        exitCode: 70,
        stderr: vi.fn().mockResolvedValue("the sandbox image must provide bash\n"),
        stdout: vi.fn().mockResolvedValue(""),
      } as never)
      .mockResolvedValueOnce(createMockCommandResult() as never);

    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(templateSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });

    expect(templateSandbox.runCommand).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(templateSandbox.runCommand).mock.calls[0]?.[0] as {
      args?: string[];
      cmd?: string;
    };
    const secondCall = vi.mocked(templateSandbox.runCommand).mock.calls[1]?.[0] as {
      args?: string[];
      cmd?: string;
      sudo?: boolean;
    };
    expect(firstCall).toMatchObject({ args: ["-lc", expect.any(String)], cmd: "bash" });
    expect(secondCall).toMatchObject({
      args: ["-n", "bash", "-lc", firstCall.args?.[1]],
      cmd: "sudo",
    });
    expect(secondCall.sudo).toBeUndefined();
  });

  it("does not append auth guidance to non-auth prewarm errors", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    vi.mocked(templateSandbox.runCommand).mockResolvedValue({
      exitCode: 1,
      stderr: vi.fn().mockResolvedValue("the sandbox image must provide bash\n"),
      stdout: vi.fn().mockResolvedValue(""),
    } as never);

    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(templateSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const backend = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    const prewarm = backend.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
      templateName: "template-key",
    });

    await expect(prewarm).rejects.toThrow(/Failed to initialize Vercel sandbox base runtime/);
    await expect(prewarm).rejects.not.toThrow(/Vercel OIDC can authenticate/);
  });
});
