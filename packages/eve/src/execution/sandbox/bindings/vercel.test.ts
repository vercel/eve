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
  const provider = createTestVercelSandbox({
    loadSandboxModule: async () => sandboxModule as never,
  });

  await provider.prepare({
    appRoot: "/tmp/test-app-root",
    seedFiles: [],
  });
  const handle = await provider.openSession({
    appRoot: "/tmp/test-app-root",
    sandboxName: "session-key",
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
  it("creates a session from the prepared snapshot artifact without looking up the template sandbox", async () => {
    const sessionSandbox = createMockSandbox({ name: "session-key" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValue(sessionSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };
    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.openSession({
      appRoot: "/tmp/test-app-root",
      prepared: { snapshotId: "prepared-snapshot" },
      sandboxName: "session-key",
    });

    expect(sandboxModule.Sandbox.get).toHaveBeenCalledTimes(1);
    expect(sandboxModule.Sandbox.get).toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.stringMatching(/^eve-sbx-vercel-/u) }),
    );
    expect(sandboxModule.Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringMatching(/^eve-sbx-vercel-/u),
        source: { snapshotId: "prepared-snapshot", type: "snapshot" },
      }),
    );
  });

  it("reuses template identity until authored source or resources change", async () => {
    async function prepareName(input: {
      createOptions?: NonNullable<Parameters<typeof createVercelImplementation>[0]>["createOptions"];
      resourcesKey?: string;
      sourceRevision: string;
    }) {
      const create = vi.fn(async (options: { name: string }) =>
        createMockSandbox({ name: options.name }),
      );
      const provider = createTestVercelSandbox({
        createOptions: input.createOptions,
        loadSandboxModule: async () =>
          ({ Sandbox: { create, get: vi.fn().mockResolvedValue(null) } }) as never,
      });
      await provider.prepare({ appRoot: "/tmp/test-app-root", ...input });
      return create.mock.calls[0]?.[0].name;
    }

    const first = await prepareName({ sourceRevision: "revision-a" });
    const unchanged = await prepareName({ sourceRevision: "revision-a" });
    const changedSource = await prepareName({ sourceRevision: "revision-b" });
    const changedResources = await prepareName({
      resourcesKey: "resources-b",
      sourceRevision: "revision-a",
    });
    const explicitImage = await prepareName({
      createOptions: { image: "registry.example/eve:custom" },
      sourceRevision: "revision-a",
    });

    expect(unchanged).toBe(first);
    expect(changedSource).not.toBe(first);
    expect(changedResources).not.toBe(first);
    expect(explicitImage).not.toBe(first);
  });

  it("uses an author-supplied image for fresh Vercel sandboxes", async () => {
    const templateSandbox = createMockSandbox({ name: "template-key" });
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockResolvedValueOnce(templateSandbox),
        get: vi.fn().mockResolvedValueOnce(null),
      },
    };

    const provider = createVercelSandbox({
      createOptions: { image: "registry.example/eve-python:1.0.0" } as never,
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
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

    const provider = createVercelSandbox({
      createOptions: { __experimentalFlag: "enabled" } as never,
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
    });

    expect(sandboxModule.Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        __experimentalFlag: "enabled",
        image: VERCEL_EVE_SANDBOX_IMAGE,
      }),
    );
  });

  it("includes Vercel SDK error response bodies in provider errors", async () => {
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

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await expect(
      provider.prepare({
        appRoot: "/tmp/test-app-root",
        seedFiles: [],
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

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
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
    });

    await provider.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
    });

    await provider.openSession({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
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

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
    });
    const handle = await provider.openSession({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
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

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
    });

    await provider.openSession({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
    });

    expect(create).toHaveBeenCalledTimes(2);
    const [templateArgs, sessionArgs] = create.mock.calls;
    expect(templateArgs?.[0]).toMatchObject({ timeout: 30 * 60 * 1_000 });
    expect(sessionArgs?.[0]).toMatchObject({ timeout: 30 * 60 * 1_000 });
  });

  it("applies mounts passed directly to open", async () => {
    const sessionSandbox = createMockSandbox({ name: "session" });
    const create = vi.fn().mockResolvedValue(sessionSandbox);
    const provider = createSandboxProviderHarness(
      createVercelImplementation({
        loadSandboxModule: async () =>
          ({ Sandbox: { create, get: vi.fn().mockResolvedValue(null) } }) as never,
      }),
      { mounts: { "/workspace/repos": { drive: "team-drive", mode: "read-write" } } },
    );
    await provider.openSession({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
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
     * instead of running preparation/resource hydration/`sandbox.snapshot()`, so the
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

    const provider = createTestVercelSandbox({
      createOptions: { source: { snapshotId: "author-snap", type: "snapshot" } },
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
    });

    await provider.openSession({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
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

  it("reports an unavailable prepared snapshot without mutating the build template", async () => {
    const snapshotExpiredError = Object.assign(
      new Error("Vercel sandbox create API returned 410"),
      { response: { status: 410 } },
    );
    const sandboxModule = {
      Sandbox: {
        create: vi.fn().mockRejectedValueOnce(snapshotExpiredError),
        get: vi.fn().mockResolvedValue(null),
      },
    };
    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await expect(
      provider.openSession({
        appRoot: "/tmp/test-app-root",
        prepared: { snapshotId: "expired-template-snapshot" },
        sandboxName: "session-key",
      }),
    ).rejects.toBeInstanceOf(SandboxTemplateNotProvisionedError);

    expect(sandboxModule.Sandbox.get).toHaveBeenCalledTimes(1);
    expect(sandboxModule.Sandbox.get).toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.stringMatching(/^eve-sbx-vercel-/u) }),
    );
    expect(sandboxModule.Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringMatching(/^eve-sbx-vercel-/u),
        source: { snapshotId: "expired-template-snapshot", type: "snapshot" },
      }),
    );
  });

  it("stops the session sandbox on shutdown so no VM outlives the server", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();

    await handle.onRuntimeShutdown();

    expect(sessionSandbox.stop).toHaveBeenCalledTimes(1);
  });

  it("stops authored compute and keeps the Vercel session handle usable", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    vi.mocked(sessionSandbox.runCommand).mockResolvedValue(createMockDetachedCommand() as never);
    vi.mocked(sessionSandbox.runCommand).mockClear();

    await handle.onSessionStop();
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
    const provider = createTestVercelSandbox({
      loadDeleteSandboxModule: async () => ({ Sandbox: { get: stableGet } }) as never,
      loadSandboxModule: async () => sandboxModule as never,
    });
    await provider.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
    });
    const handle = await provider.openSession({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
    });
    const abortSignal = new AbortController().signal;

    await expect(handle.onSessionDelete({ abortSignal })).resolves.toBeUndefined();

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
    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });
    await provider.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
    });
    const handle = await provider.openSession({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
    });

    await handle.onRuntimeShutdown();

    expect(sessionSandbox.stop).not.toHaveBeenCalled();
  });

  it("surfaces an authored session stop failure", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    sessionSandbox.stop.mockRejectedValueOnce(new Error("provider unreachable"));

    await expect(handle.onSessionStop()).rejects.toThrow("provider unreachable");
  });

  it("applies the open-time policy after template-less base setup", async () => {
    const sessionSandbox = createMockSandbox({ name: "session" });
    const create = vi.fn().mockResolvedValue(sessionSandbox);
    const provider = createSandboxProviderHarness(
      createVercelImplementation({
        createSandbox: async ({ createOptions }) => {
          await create(createOptions);
          return sessionSandbox as never;
        },
        loadSandboxModule: async () =>
          ({ Sandbox: { create, get: vi.fn().mockResolvedValue(null) } }) as never,
      }),
      { networkPolicy: "deny-all" },
      { preparedArtifact: () => ({}) },
    );

    await provider.start({ appRoot: "/tmp/test-app-root", sandboxName: "session-key" });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ networkPolicy: "allow-all" }));
    expect(sessionSandbox.update).toHaveBeenCalledWith({ networkPolicy: "deny-all" });
    expect(sessionSandbox.runCommand.mock.invocationCallOrder[0]).toBeLessThan(
      sessionSandbox.update.mock.invocationCallOrder[0]!,
    );
  });

  it("discards a fresh template-less session when applying its policy fails", async () => {
    const sessionSandbox = createMockSandbox({ name: "session" });
    sessionSandbox.update.mockRejectedValueOnce(new Error("policy rejected"));
    const stableDelete = vi.fn().mockResolvedValue(undefined);
    const provider = createSandboxProviderHarness(
      createVercelImplementation({
        createSandbox: async () => sessionSandbox as never,
        loadDeleteSandboxModule: async () =>
          ({ Sandbox: { get: vi.fn().mockResolvedValue({ delete: stableDelete }) } }) as never,
        loadSandboxModule: async () =>
          ({ Sandbox: { get: vi.fn().mockResolvedValue(null) } }) as never,
      }),
      { networkPolicy: "deny-all" },
      { preparedArtifact: () => ({}) },
    );

    await expect(
      provider.start({ appRoot: "/tmp/test-app-root", sandboxName: "session-key" }),
    ).rejects.toThrow("policy rejected");
    expect(sessionSandbox.stop).toHaveBeenCalledTimes(1);
    expect(stableDelete).toHaveBeenCalledTimes(1);
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

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
    });

    const handle = await provider.openSession({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
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

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
    });

    const handle = await provider.openSession({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
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

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
    });
    const handle = await provider.openSession({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
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

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
    });
    const handle = await provider.openSession({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
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

  it("exposes a stable provider name", () => {
    const provider = createTestVercelSandbox();
    expect(provider).toBeDefined();
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

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
    });

    await provider.openSession({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
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

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
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

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    const prewarm = provider.prepare({
      appRoot: "/tmp/test-app-root",
      seedFiles: [],
    });

    await expect(prewarm).rejects.toThrow(/Failed to initialize Vercel sandbox base runtime/);
    await expect(prewarm).rejects.not.toThrow(/Vercel OIDC can authenticate/);
  });
});
