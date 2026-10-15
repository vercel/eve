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
  sourceSnapshotId?: string;
  status?: string;
  tags?: Record<string, string>;
}) {
  const files = new Map<string, Buffer>();
  let tags = input.tags;
  const sandbox = {
    currentSnapshotId: input.snapshotId ?? "",
    delete: vi.fn().mockResolvedValue(undefined),
    fs: {
      rm: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn().mockResolvedValue(undefined),
    },
    name: input.name,
    sourceSnapshotId: input.sourceSnapshotId,
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
    // Like the SDK, a snapshot becomes the sandbox's `currentSnapshotId`.
    snapshot: vi.fn(async () => {
      sandbox.currentSnapshotId = `${input.name}-snapshot`;
      return { snapshotId: sandbox.currentSnapshotId };
    }),
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
  return sandbox;
}

/**
 * `Sandbox.create` returning `sandboxes` in order, except that a build's
 * template pointer (named exactly by the template key) gets a fresh mock.
 */
function createSandboxesInOrder(...sandboxes: ReadonlyArray<ReturnType<typeof createMockSandbox>>) {
  const queue = [...sandboxes];
  return vi.fn(async (options: MockCreateOptions) =>
    TEMPLATE_POINTER_NAME.test(options.name)
      ? createMockSandbox({ ...mockFromCreateOptions(options), status: "stopped" })
      : queue.shift(),
  );
}

interface MockCreateOptions {
  name: string;
  source?: { snapshotId?: string; type: string };
  tags?: Record<string, string>;
}

/** What a sandbox created with `options` reports, like the SDK: its name, tags and source snapshot. */
function mockFromCreateOptions(options: MockCreateOptions) {
  return {
    name: options.name,
    sourceSnapshotId: options.source?.type === "snapshot" ? options.source.snapshotId : undefined,
    tags: options.tags,
  };
}

const TEMPLATE_POINTER_NAME = /^eve-sbx-tpl-vercel-[0-9a-f]{32}$/u;

/**
 * A Sandbox API stand-in that keeps sandboxes by name and snapshots by ID the
 * way the real one does: a taken name rejects `create` with 400, `delete`
 * removes whatever holds the name, and a snapshot outlives its sandbox.
 * `create` hands out `presets` in order before making fresh mocks.
 */
function createFakeVercelProvider(...presets: ReadonlyArray<ReturnType<typeof createMockSandbox>>) {
  const sandboxes = new Map<string, ReturnType<typeof createMockSandbox>>();
  const snapshots = new Set<string>();
  const queue = [...presets];
  const missing = () => Object.assign(new Error("Not found"), { response: { status: 404 } });
  function add(sandbox: ReturnType<typeof createMockSandbox>) {
    const name = sandbox.name;
    sandboxes.set(name, sandbox);
    sandbox.delete.mockImplementation(async () => {
      if (!sandboxes.delete(name)) throw missing();
    });
    // Stopping a sandbox someone else deleted fails like the real API: 404.
    sandbox.stop.mockImplementation(async () => {
      if (sandboxes.get(name) !== sandbox) throw missing();
    });
    sandbox.snapshot.mockImplementation(async () => {
      snapshots.add(`${name}-snapshot`);
      return { snapshotId: `${name}-snapshot` };
    });
    return sandbox;
  }
  const sandboxModule = {
    Sandbox: {
      create: vi.fn(async (options: MockCreateOptions) => {
        if (sandboxes.has(options.name)) {
          throw Object.assign(
            new Error(`A sandbox with the name '${options.name}' already exists for this project.`),
            { response: { status: 400 } },
          );
        }
        const preset = TEMPLATE_POINTER_NAME.test(options.name) ? undefined : queue.shift();
        const sandbox = preset ?? createMockSandbox(mockFromCreateOptions(options));
        sandbox.name = options.name;
        return add(sandbox);
      }),
      get: vi.fn(async (options: { name: string }) => sandboxes.get(options.name) ?? null),
    },
    Snapshot: {
      get: vi.fn(async (options: { snapshotId: string }) => {
        if (!snapshots.has(options.snapshotId)) throw missing();
        return { snapshotId: options.snapshotId, status: "created" };
      }),
    },
  };
  /** Puts a sandbox under the template key before any build runs. */
  function seedTemplate(name: string, sandbox: ReturnType<typeof createMockSandbox>) {
    sandbox.name = name;
    add(sandbox);
  }
  const pointer = () =>
    [...sandboxes.values()].find((sandbox) => TEMPLATE_POINTER_NAME.test(sandbox.name));
  return { pointer, sandboxModule, sandboxes, seedTemplate, snapshots };
}

/** The template key a build of this provider configuration uses. */
async function templateKeyOf(build: (module: object) => Promise<unknown>): Promise<string> {
  const fake = createFakeVercelProvider();
  await build(fake.sandboxModule);
  const name = fake.pointer()?.name;
  if (name === undefined) throw new Error("build published no template");
  return name;
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
      create: createSandboxesInOrder(templateSandbox, sessionSandbox),
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

  it("creates sandboxes with Vercel API credentials from the environment", async () => {
    vi.stubEnv("VERCEL_TEAM_ID", "team_env");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_env");
    vi.stubEnv("VERCEL_TOKEN", "token_env");
    const sandboxModule = {
      Sandbox: {
        create: createSandboxesInOrder(
          createMockSandbox({ name: "template" }),
          createMockSandbox({ name: "session" }),
        ),
        get: vi.fn().mockResolvedValue(null),
      },
    };
    const provider = createVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({ appRoot: "/tmp/test-app-root", seedFiles: [] });
    await provider.openSession({
      appRoot: "/tmp/test-app-root",
      prepared: { snapshotId: "prepared-snapshot" },
      sandboxName: "session-key",
    });

    const credentials = { projectId: "prj_env", teamId: "team_env", token: "token_env" };
    expect(sandboxModule.Sandbox.create.mock.calls.map(([options]) => options)).toEqual([
      expect.objectContaining({ ...credentials, image: VERCEL_EVE_SANDBOX_IMAGE }),
      // The template pointer, then the session.
      expect.objectContaining({
        ...credentials,
        source: expect.objectContaining({ type: "snapshot" }),
      }),
      expect.objectContaining({
        ...credentials,
        source: expect.objectContaining({ type: "snapshot" }),
      }),
    ]);
  });

  it("reuses template identity until authored source or resources change", async () => {
    async function prepareName(input: {
      createOptions?: NonNullable<
        Parameters<typeof createVercelImplementation>[0]
      >["createOptions"];
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
      return create.mock.calls.find(([options]) => TEMPLATE_POINTER_NAME.test(options.name))?.[0]
        .name;
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
        create: createSandboxesInOrder(templateSandbox),
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
        create: createSandboxesInOrder(templateSandbox),
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
    const { sandboxModule } = createFakeVercelProvider(templateSandbox, sessionSandbox);

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
        create: createSandboxesInOrder(templateSandbox, sessionSandbox),
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
    const create = createSandboxesInOrder(templateSandbox, sessionSandbox);
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

    // The template, its pointer, then the session.
    expect(create).toHaveBeenCalledTimes(3);
    const [templateArgs, , sessionArgs] = create.mock.calls;
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

  describe("tool sessions", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    // What the Sandbox API answers a resume whose snapshot expired or was deleted.
    const snapshotNotFound = () =>
      Object.assign(new Error("Cannot resume sandbox: no snapshot available."), {
        json: { error: { code: "snapshot_not_found" } },
        response: { status: 410 },
      });
    const nameTaken = () =>
      Object.assign(new Error("A sandbox with the name already exists"), {
        response: { status: 400 },
      });

    /*
     * A Vercel project over `sandboxes`, by name. `create` fails for a name
     * that is taken, as the API does, so a test can let another instance win
     * a name before this one's create lands.
     */
    function project(sandboxes: Map<string, ReturnType<typeof createMockSandbox>>) {
      const sandboxModule = {
        Sandbox: {
          create: vi.fn(async (options: { name: string }) => {
            if (sandboxes.has(options.name)) throw nameTaken();
            const created = createMockSandbox({ name: options.name });
            sandboxes.set(options.name, created);
            return created;
          }),
          get: vi.fn(async (options: { name: string }) => sandboxes.get(options.name) ?? null),
        },
      };
      const provider = createTestVercelSandbox({
        loadDeleteSandboxModule: async () => sandboxModule as never,
        loadSandboxModule: async () => sandboxModule as never,
      });
      const open = async (sessionId = "tool_session_abc") =>
        await provider.openSession({
          appRoot: "/tmp/test-app-root",
          prepared: { snapshotId: "prepared-snapshot" },
          sandboxName: sessionId,
        });
      return { open, sandboxModule };
    }

    function expiredSandbox(
      sandboxes: Map<string, ReturnType<typeof createMockSandbox>>,
      name: string,
    ) {
      const sandbox = createMockSandbox({ name, status: "stopped" });
      sandbox.runCommand.mockRejectedValue(snapshotNotFound());
      sandbox.delete.mockImplementation(async () => {
        sandboxes.delete(name);
      });
      sandboxes.set(name, sandbox);
      return sandbox;
    }

    async function baseName() {
      const sandboxes = new Map<string, ReturnType<typeof createMockSandbox>>();
      await project(sandboxes).open();
      return [...sandboxes.keys()][0]!;
    }

    it("expires a tool session's snapshots a day after last use and keeps only the latest", async () => {
      const { open, sandboxModule } = project(new Map());
      await open();
      expect(sandboxModule.Sandbox.create).toHaveBeenCalledWith(
        expect.objectContaining({ keepLastSnapshots: { count: 1 }, snapshotExpiration: DAY_MS }),
      );
    });

    it("leaves a conversation session's snapshot retention to the author", async () => {
      const { open, sandboxModule } = project(new Map());
      await open("session-key");
      const params = sandboxModule.Sandbox.create.mock.calls[0]?.[0];
      expect(params).not.toHaveProperty("keepLastSnapshots");
      expect(params).not.toHaveProperty("snapshotExpiration");
    });

    it("resumes a stopped sandbox whose snapshot is still there, keeping it", async () => {
      const base = await baseName();
      const stopped = createMockSandbox({ name: base, status: "stopped" });
      const { open, sandboxModule } = project(new Map([[base, stopped]]));

      await open();

      expect(stopped.runCommand).toHaveBeenCalled();
      expect(stopped.delete).not.toHaveBeenCalled();
      expect(sandboxModule.Sandbox.create).not.toHaveBeenCalled();
    });

    it("starts a fresh sandbox under the same name once the snapshot expired", async () => {
      const base = await baseName();
      const sandboxes = new Map<string, ReturnType<typeof createMockSandbox>>();
      const expired = expiredSandbox(sandboxes, base);
      const { open, sandboxModule } = project(sandboxes);

      await open();

      expect(expired.delete).toHaveBeenCalledTimes(1);
      expect(sandboxModule.Sandbox.create).toHaveBeenCalledTimes(1);
      expect(sandboxModule.Sandbox.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: base,
          snapshotExpiration: DAY_MS,
          source: { snapshotId: "prepared-snapshot", type: "snapshot" },
        }),
      );
      expect(sandboxes.get(base)?.runCommand).toHaveBeenCalled();
    });

    it("adopts the fresh sandbox another instance made first after the same expiry", async () => {
      const base = await baseName();
      const sandboxes = new Map<string, ReturnType<typeof createMockSandbox>>();
      const expired = expiredSandbox(sandboxes, base);
      const { open, sandboxModule } = project(sandboxes);
      // Another instance recreates the name after this one finds it free
      // and before its create lands.
      const theirs = createMockSandbox({ name: base });
      const get = sandboxModule.Sandbox.get.getMockImplementation()!;
      sandboxModule.Sandbox.get.mockImplementation(async (options) => {
        const found = await get(options);
        if (found === null && !sandboxes.has(base)) sandboxes.set(base, theirs);
        return found;
      });

      await open();

      expect(sandboxModule.Sandbox.create).toHaveBeenCalledTimes(1);
      await expect(sandboxModule.Sandbox.create.mock.results[0]!.value).rejects.toThrow(
        "already exists",
      );
      expect(expired.delete).toHaveBeenCalledTimes(1);
      expect(theirs.runCommand).toHaveBeenCalled();
      expect(theirs.delete).not.toHaveBeenCalled();
    });

    it("starts fresh when another instance already deleted the expired sandbox", async () => {
      const base = await baseName();
      const sandboxes = new Map<string, ReturnType<typeof createMockSandbox>>();
      expiredSandbox(sandboxes, base);
      const { open, sandboxModule } = project(sandboxes);
      const get = sandboxModule.Sandbox.get.getMockImplementation()!;
      sandboxModule.Sandbox.get.mockImplementationOnce(get).mockImplementationOnce(async () => {
        sandboxes.delete(base);
        throw Object.assign(new Error("Sandbox not found"), { response: { status: 404 } });
      });

      await open();

      expect(sandboxModule.Sandbox.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: base }),
      );
      expect(sandboxes.get(base)?.runCommand).toHaveBeenCalled();
    });

    it("surfaces any other 410 instead of replacing the sandbox", async () => {
      const base = await baseName();
      const gone = createMockSandbox({ name: base, status: "stopped" });
      gone.runCommand.mockRejectedValue(
        Object.assign(new Error("Session is gone"), { response: { status: 410 } }),
      );
      const { open, sandboxModule } = project(new Map([[base, gone]]));

      await expect(open()).rejects.toThrow();
      expect(sandboxModule.Sandbox.create).not.toHaveBeenCalled();
      expect(gone.delete).not.toHaveBeenCalled();
    });
  });

  describe("shared templates", () => {
    const buildWith = (prepare?: () => Promise<void> | void) => async (sandboxModule: object) =>
      await createTestVercelSandbox({
        loadSandboxModule: async () => sandboxModule as never,
        prepare,
      }).prepare({ appRoot: "/tmp/test-app-root", seedFiles: [] });

    /** The build-private sandboxes: everything a build created except the template pointer. */
    const privateSandboxes = (fake: ReturnType<typeof createFakeVercelProvider>) =>
      fake.sandboxModule.Sandbox.create.mock.results
        .map((result) => result.value as Promise<ReturnType<typeof createMockSandbox>>)
        .filter((_, index) => {
          const name = fake.sandboxModule.Sandbox.create.mock.calls[index]?.[0].name ?? "";
          return !TEMPLATE_POINTER_NAME.test(name);
        });

    it("lets two builds that look the template up at once both succeed", async () => {
      const fake = createFakeVercelProvider();
      let lookups = 0;
      let releaseLookups!: () => void;
      const bothLookedUp = new Promise<void>((resolve) => {
        releaseLookups = resolve;
      });
      // Both builds look the template up before either one publishes it.
      fake.sandboxModule.Sandbox.get.mockImplementation(async (options: { name: string }) => {
        const found = fake.sandboxes.get(options.name) ?? null;
        if (++lookups === 2) releaseLookups();
        await bothLookedUp;
        return found;
      });
      const build = buildWith();

      const results = await Promise.allSettled([
        build(fake.sandboxModule),
        build(fake.sandboxModule),
      ]);

      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        expect(fake.snapshots.has(result.value.snapshotId ?? "")).toBe(true);
      }
      for (const sandbox of await Promise.all(privateSandboxes(fake))) {
        expect(sandbox.snapshot).toHaveBeenCalledTimes(1);
      }
      // Only the pointer remains: each build deleted the sandbox it prepared in.
      expect([...fake.sandboxes.keys()]).toEqual([fake.pointer()?.name]);
    });

    it("never prepares one sandbox for two builds", async () => {
      const fake = createFakeVercelProvider();
      let finishFirst!: () => void;
      const firstFinished = new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      const prepare = vi
        .fn<() => Promise<void>>()
        .mockImplementationOnce(async () => await firstFinished)
        .mockResolvedValue(undefined);
      const build = buildWith(prepare);

      const first = build(fake.sandboxModule);
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
      // The second build starts while the first is still preparing, and doesn't wait for it.
      const second = await build(fake.sandboxModule);
      finishFirst();
      const firstResult = await first;

      const [firstSandbox, secondSandbox] = await Promise.all(privateSandboxes(fake));
      expect(firstResult).toEqual({ snapshotId: `${firstSandbox?.name}-snapshot` });
      expect(second).toEqual({ snapshotId: `${secondSandbox?.name}-snapshot` });
      expect(firstSandbox?.snapshot).toHaveBeenCalledTimes(1);
      expect(secondSandbox?.snapshot).toHaveBeenCalledTimes(1);
      // The first build to finish published the template; the other kept its own snapshot.
      expect(fake.pointer()?.sourceSnapshotId).toBe(second.snapshotId);
    });

    it("reuses a published template without preparing again", async () => {
      const fake = createFakeVercelProvider();
      const prepare = vi.fn();
      const build = buildWith(prepare);

      const first = await build(fake.sandboxModule);
      const creates = fake.sandboxModule.Sandbox.create.mock.calls.length;
      const second = await build(fake.sandboxModule);

      expect(second).toEqual(first);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(fake.sandboxModule.Sandbox.create).toHaveBeenCalledTimes(creates);
    });

    it("leaves no template behind when preparation fails, so the next build prepares", async () => {
      const fake = createFakeVercelProvider();
      const prepare = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("prepare failed"))
        .mockResolvedValue(undefined);
      const build = buildWith(prepare);

      await expect(build(fake.sandboxModule)).rejects.toThrow(/prepare failed/);
      expect(fake.sandboxes.size).toBe(0);

      const next = await build(fake.sandboxModule);
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(fake.pointer()?.sourceSnapshotId).toBe(next.snapshotId);
    });

    it("ignores the automatic snapshot of a template whose build was abandoned", async () => {
      const templateKey = await templateKeyOf(buildWith());
      const fake = createFakeVercelProvider();
      // A persistent template sandbox Vercel snapshotted when its timeout stopped it mid-preparation.
      const abandoned = createMockSandbox({
        name: templateKey,
        snapshotId: "abandoned-auto-snapshot",
        status: "stopped",
      });
      fake.seedTemplate(templateKey, abandoned);
      fake.snapshots.add("abandoned-auto-snapshot");
      const prepare = vi.fn();

      const result = await buildWith(prepare)(fake.sandboxModule);

      expect(result.snapshotId).not.toBe("abandoned-auto-snapshot");
      expect(fake.snapshots.has(result.snapshotId ?? "")).toBe(true);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(abandoned.snapshot).not.toHaveBeenCalled();
      expect(fake.pointer()?.sourceSnapshotId).toBe(result.snapshotId);
    });

    it("lets two builds replace the same stale template without deleting each other's work", async () => {
      const templateKey = await templateKeyOf(buildWith());
      const fake = createFakeVercelProvider();
      // A pointer to a snapshot that has since expired.
      fake.seedTemplate(
        templateKey,
        createMockSandbox({
          name: templateKey,
          sourceSnapshotId: "expired",
          status: "stopped",
        }),
      );
      let lookups = 0;
      let releaseLookups!: () => void;
      const bothLookedUp = new Promise<void>((resolve) => {
        releaseLookups = resolve;
      });
      fake.sandboxModule.Sandbox.get.mockImplementation(async (options: { name: string }) => {
        const found = fake.sandboxes.get(options.name) ?? null;
        if (++lookups === 2) releaseLookups();
        await bothLookedUp;
        return found;
      });
      const build = buildWith();

      const results = await Promise.all([build(fake.sandboxModule), build(fake.sandboxModule)]);

      const snapshotIds = results.map((result) => result.snapshotId ?? "");
      expect(new Set(snapshotIds).size).toBe(2);
      for (const snapshotId of snapshotIds) expect(fake.snapshots.has(snapshotId)).toBe(true);
      for (const sandbox of await Promise.all(privateSandboxes(fake))) {
        expect(sandbox.snapshot).toHaveBeenCalledTimes(1);
        expect(sandbox.delete).toHaveBeenCalledTimes(1);
      }
      expect(snapshotIds).toContain(fake.pointer()?.sourceSnapshotId);
    });

    it("keeps a build's snapshot when another build deletes its new pointer mid-publish", async () => {
      const templateKey = await templateKeyOf(buildWith());
      const fake = createFakeVercelProvider();
      const stale = createMockSandbox({
        name: templateKey,
        sourceSnapshotId: "expired",
        status: "stopped",
      });
      fake.seedTemplate(templateKey, stale);
      let lookups = 0;
      let releaseLookups!: () => void;
      const bothLookedUp = new Promise<void>((resolve) => {
        releaseLookups = resolve;
      });
      fake.sandboxModule.Sandbox.get.mockImplementation(async (options: { name: string }) => {
        const found = fake.sandboxes.get(options.name) ?? null;
        if (++lookups === 2) releaseLookups();
        await bothLookedUp;
        return found;
      });
      /*
       * A deletes the stale pointer and creates its own; before A stops it,
       * B's delete of the stale pointer it saw removes A's new one by name.
       */
      let pointerCreated!: () => void;
      const firstPointerCreated = new Promise<void>((resolve) => {
        pointerCreated = resolve;
      });
      let staleDeletedTwice!: () => void;
      const secondStaleDelete = new Promise<void>((resolve) => {
        staleDeletedTwice = resolve;
      });
      const deleteByName = stale.delete.getMockImplementation();
      stale.delete.mockImplementation(async () => {
        if (stale.delete.mock.calls.length === 1) return await deleteByName?.();
        await firstPointerCreated;
        await deleteByName?.();
        staleDeletedTwice();
      });
      const create = fake.sandboxModule.Sandbox.create.getMockImplementation();
      let pointers = 0;
      fake.sandboxModule.Sandbox.create.mockImplementation(async (options: MockCreateOptions) => {
        const sandbox = await create!(options);
        if (TEMPLATE_POINTER_NAME.test(options.name) && ++pointers === 1) {
          const stop = sandbox.stop.getMockImplementation();
          sandbox.stop.mockImplementation(async () => {
            pointerCreated();
            await secondStaleDelete;
            await stop?.();
          });
        }
        return sandbox;
      });
      const build = buildWith();

      const results = await Promise.allSettled([
        build(fake.sandboxModule),
        build(fake.sandboxModule),
      ]);

      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        expect(fake.snapshots.has(result.value.snapshotId ?? "")).toBe(true);
      }
      // The second build's pointer replaced the one it deleted.
      expect(pointers).toBe(2);
    });

    it("keeps the author's tags on the published template", async () => {
      const fake = createFakeVercelProvider();

      await createTestVercelSandbox({
        createOptions: { tags: { team: "x" } },
        loadSandboxModule: async () => fake.sandboxModule as never,
      }).prepare({ appRoot: "/tmp/test-app-root", seedFiles: [] });

      expect(fake.pointer()?.tags).toEqual({ team: "x" });
    });
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
    const create = createSandboxesInOrder(templateSandbox, sessionSandbox);
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

    // The template, its pointer, then the session.
    expect(create).toHaveBeenCalledTimes(3);
    const [templateArgs, , sessionArgs] = create.mock.calls;
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

    await handle.onSandboxStop();
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
        create: createSandboxesInOrder(templateSandbox, sessionSandbox),
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

    await expect(handle.onSandboxDelete({ abortSignal })).resolves.toBeUndefined();

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
        create: createSandboxesInOrder(templateSandbox, sessionSandbox),
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

    await expect(handle.onSandboxStop()).rejects.toThrow("provider unreachable");
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
        create: createSandboxesInOrder(templateSandbox, sessionSandbox),
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

    expect(handle.sandbox.name).toBe("session");

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
        create: createSandboxesInOrder(templateSandbox, sessionSandbox),
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

  it("forwards env with the AI_AGENT default to runCommand when spawning a process", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const sandboxModule = {
      Sandbox: {
        create: createSandboxesInOrder(templateSandbox, sessionSandbox),
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
        env: { AI_AGENT: "eve", DEPLOY_ENV: "staging" },
      }),
    );
  });

  it("lets environment env override the AI_AGENT default when running a command", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const sandboxModule = {
      Sandbox: {
        create: createSandboxesInOrder(templateSandbox, sessionSandbox),
        get: vi.fn().mockResolvedValue(null),
      },
    };

    const provider = createTestVercelSandbox({
      createOptions: { env: { AI_AGENT: "alice-bot" } },
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
        env: { AI_AGENT: "alice-bot", DEPLOY_ENV: "production" },
      }),
    );
  });

  it("prepares the base runtime during sandbox init", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const sandboxModule = {
      Sandbox: {
        create: createSandboxesInOrder(templateSandbox, sessionSandbox),
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
        create: createSandboxesInOrder(templateSandbox),
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
        create: createSandboxesInOrder(templateSandbox),
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
