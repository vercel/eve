import { sandboxConnectionDisposal } from "#execution/sandbox/connection-disposal.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { shutdownActiveSandboxConnections } from "#execution/sandbox/active-connections.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SandboxSessionGoneError } from "#shared/sandbox-session-gone-error.js";
import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";
import {
  VERCEL_EVE_GIT_SANDBOX_IMAGE,
  VERCEL_EVE_SANDBOX_IMAGE,
} from "#execution/sandbox/bindings/eve-image.js";
import {
  createVercelSandbox as createVercelImplementation,
  type VercelSandboxPreparedArtifact,
  type VercelSandboxSessionState,
} from "#execution/sandbox/bindings/vercel.js";
import { createSandboxEnvironmentHarness } from "#internal/testing/sandbox-provider-harness.js";
import { defineSandboxProvider } from "#public/sandbox/provider.js";
import type { VercelSandboxSession } from "#public/sandbox/vercel.js";
import type { VercelSandboxRuntimeOptions } from "#public/sandbox/vercel-sandbox.js";
import { VercelSandbox } from "#sandbox/providers/vercel.js";
import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";
import { DefaultSandbox } from "#sandbox/providers/default.js";
import { getSandboxTemplateRebuilder } from "#sandbox/template-rebuild.js";

vi.mock("#runtime/sandbox/prepared-artifacts.js", () => ({
  loadSandboxPreparedArtifact: vi.fn(async () => ({ snapshotId: "prepared-snapshot" })),
}));

vi.mock("#compiled/@vercel/oidc/index.js", () => ({
  getVercelOidcToken: vi.fn(async () => {
    throw new Error("No ambient Vercel OIDC token in unit tests.");
  }),
}));

const sdk = vi.hoisted(() => ({
  module: undefined as { Sandbox: object; Snapshot: object } | undefined,
}));
vi.mock("#compiled/@vercel/sandbox/index.js", () => ({
  get Sandbox() {
    return sdk.module?.Sandbox;
  },
  get Snapshot() {
    return sdk.module?.Snapshot;
  },
}));

vi.mock("#execution/sandbox/bindings/eve-image.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  VERCEL_EVE_SANDBOX_IMAGE: "vcr.vercel.com/vercel/eve/base:golden",
}));

function createMockCommandResult() {
  return {
    exitCode: 0,
    stderr: vi.fn().mockResolvedValue(""),
    stdout: vi.fn().mockResolvedValue(""),
  };
}

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
  const session = {
    createdAt: new Date(),
    startedAt: new Date(),
    status: input.status ?? "running",
    timeout: 30 * 60_000,
    extendTimeout: vi.fn(
      async (duration: number, _options?: { signal?: AbortSignal }): Promise<void> => {
        session.timeout += duration;
      },
    ),
  };
  let tags = input.tags;
  const sandbox = {
    currentSnapshotId: input.snapshotId ?? "",
    currentSession: () => session,
    timeout: 30 * 60_000,
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
              stdout: vi.fn().mockResolvedValue(
                (command.args ?? [])
                  .slice(3)
                  .map((path) => `${path}\0`)
                  .join(""),
              ),
            }
          : createMockCommandResult(),
      ),
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

function mockFromCreateOptions(options: MockCreateOptions) {
  return {
    name: options.name,
    sourceSnapshotId: options.source?.type === "snapshot" ? options.source.snapshotId : undefined,
    tags: options.tags,
  };
}

const TEMPLATE_POINTER_NAME = /^eve-sbx-tpl-vercel-[0-9a-f]{32}$/u;

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
        return {
          delete: vi.fn(async () => {
            snapshots.delete(options.snapshotId);
          }),
          snapshotId: options.snapshotId,
          status: "created",
        };
      }),
    },
  };
  function seedTemplate(name: string, sandbox: ReturnType<typeof createMockSandbox>) {
    sandbox.name = name;
    add(sandbox);
  }
  const pointer = () =>
    [...sandboxes.values()].find((sandbox) => TEMPLATE_POINTER_NAME.test(sandbox.name));
  return { pointer, sandboxModule, sandboxes, seedTemplate, snapshots };
}

async function templateKeyOf(build: (module: object) => Promise<unknown>): Promise<string> {
  const fake = createFakeVercelProvider();
  await build(fake.sandboxModule);
  const name = fake.pointer()?.name;
  if (name === undefined) throw new Error("build published no template");
  return name;
}

type VercelTestInput = NonNullable<Parameters<typeof createVercelImplementation>[0]> & {
  readonly prepare?: (sandbox: VercelSandboxSession) => Promise<void> | void;
};

function vercelHarness(
  { prepare, ...input }: VercelTestInput = {},
  options: VercelSandboxRuntimeOptions = {},
  harnessOptions: { readonly preparedArtifact?: () => VercelSandboxPreparedArtifact } = {},
) {
  const provider = defineSandboxProvider({
    name: "vercel",
    environment: () => createVercelImplementation(input),
  });
  return createSandboxEnvironmentHarness<
    VercelSandboxRuntimeOptions,
    VercelSandboxPreparedArtifact,
    VercelSandboxSessionState,
    VercelSandboxSession
  >(provider.environment(prepare === undefined ? {} : { prepare }), options, harnessOptions);
}

function createVercelSandbox(input: VercelTestInput = {}) {
  return vercelHarness({ prepare: async () => {}, ...input });
}

function createTestVercelSandbox(input: VercelTestInput = {}) {
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
  const snapshotNotFound = () =>
    Object.assign(new Error("Cannot resume sandbox: no snapshot available."), {
      json: { error: { code: "snapshot_not_found" } },
      response: { status: 410 },
    });

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
    expect(sessionSandbox.runCommand).not.toHaveBeenCalled();
  });

  it("runs no base setup for a prepared snapshot of the eve-git image", async () => {
    const sessionSandbox = createMockSandbox({ name: "session-key" });
    const provider = createTestVercelSandbox({
      createOptions: { image: VERCEL_EVE_GIT_SANDBOX_IMAGE },
      loadSandboxModule: async () =>
        ({
          Sandbox: {
            create: vi.fn().mockResolvedValue(sessionSandbox),
            get: vi.fn().mockResolvedValue(null),
          },
        }) as never,
    });

    await provider.openSession({
      appRoot: "/tmp/test-app-root",
      prepared: { snapshotId: "prepared-snapshot" },
      sandboxName: "session-key",
    });

    expect(sessionSandbox.runCommand).not.toHaveBeenCalled();
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

    await provider.prepare({ appRoot: "/tmp/test-app-root" });
    await provider.openSession({
      appRoot: "/tmp/test-app-root",
      prepared: { snapshotId: "prepared-snapshot" },
      sandboxName: "session-key",
    });

    const credentials = { projectId: "prj_env", teamId: "team_env", token: "token_env" };
    expect(sandboxModule.Sandbox.create.mock.calls.map(([options]) => options)).toEqual([
      expect.objectContaining({ ...credentials, image: VERCEL_EVE_SANDBOX_IMAGE }),
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
      createOptions?: VercelTestInput["createOptions"];
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

  it("reports a create option the template key cannot hash as a Vercel preparation failure", async () => {
    const provider = createTestVercelSandbox({
      createOptions: { resources: new Map() } as never,
      loadSandboxModule: async () => createFakeVercelProvider().sandboxModule as never,
    });

    await expect(provider.prepare({ appRoot: "/tmp/test-app-root" })).rejects.toThrow(
      /^Failed to prepare Vercel sandbox snapshot: ctx\.templateKey\(\) accepts only JSON values/,
    );
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
      }),
    ).rejects.toThrow(/The sandbox request is invalid/);
  });

  it("resolves symlinked destinations before writing files", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    vi.mocked(sessionSandbox.runCommand).mockResolvedValueOnce({
      ...createMockCommandResult(),
      stdout: vi.fn().mockResolvedValue("/workspace/repository/agent/instructions.md\0"),
    });

    await handle.sandbox.writeTextFile({
      content: "updated instructions\n",
      path: "/source/instructions.md",
    });

    expect(sessionSandbox.runCommand).toHaveBeenLastCalledWith({
      args: ["-m", "-z", "--", "/source/instructions.md"],
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

  it("writes a batch of files with one realpath call and one upload", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    vi.mocked(sessionSandbox.runCommand).mockClear();

    await handle.sandbox.writeFiles({
      files: [
        { content: Buffer.from("A"), path: "/home/agent/.agents/skills/policy/a.md" },
        { content: Buffer.from("B"), path: "skills/policy/b notes.md " },
      ],
    });

    expect(sessionSandbox.runCommand).toHaveBeenCalledOnce();
    expect(sessionSandbox.runCommand).toHaveBeenCalledWith({
      args: [
        "-m",
        "-z",
        "--",
        "/home/agent/.agents/skills/policy/a.md",
        "/workspace/skills/policy/b notes.md ",
      ],
      cmd: "realpath",
      signal: undefined,
    });
    expect(sessionSandbox.writeFiles).toHaveBeenLastCalledWith(
      [
        { content: Buffer.from("A"), path: "/home/agent/.agents/skills/policy/a.md" },
        { content: Buffer.from("B"), path: "/workspace/skills/policy/b notes.md " },
      ],
      { signal: undefined },
    );
  });

  it("splits the realpath arguments of a large batch across calls and still uploads once", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    vi.mocked(sessionSandbox.runCommand).mockReset();
    vi.mocked(sessionSandbox.runCommand).mockImplementation(
      async (command: { args?: readonly string[] }) => ({
        ...createMockCommandResult(),
        stdout: vi.fn().mockResolvedValue(
          (command.args ?? [])
            .slice(3)
            .map((path) => `/real${path}\0`)
            .join(""),
        ),
      }),
    );
    const paths = Array.from(
      { length: 2_000 },
      (_, index) => `/workspace/${"nested/".repeat(12)}file-${index}.txt`,
    );

    await handle.sandbox.writeFiles({
      files: paths.map((path) => ({ content: Buffer.from(path), path })),
    });

    const calls = vi
      .mocked(sessionSandbox.runCommand)
      .mock.calls.map(([command]) => (command as { args: string[] }).args);
    expect(calls.length).toBeGreaterThan(1);
    for (const args of calls) {
      expect(args.slice(0, 3)).toEqual(["-m", "-z", "--"]);
      expect(Buffer.byteLength(args.join(" "))).toBeLessThan(100 * 1024);
    }
    expect(calls.flatMap((args) => args.slice(3))).toEqual(paths);
    expect(sessionSandbox.writeFiles).toHaveBeenCalledOnce();
    expect(sessionSandbox.writeFiles).toHaveBeenLastCalledWith(
      paths.map((path) => ({ content: Buffer.from(path), path: `/real${path}` })),
      { signal: undefined },
    );
  });

  it("resolves and writes all seed paths to the sandbox filesystem in one batch", async () => {
    const templateSandbox = createMockSandbox({ name: "template" });
    const sessionSandbox = createMockSandbox({ name: "session" });
    const runCommand = templateSandbox.runCommand.getMockImplementation()!;
    vi.mocked(templateSandbox.runCommand).mockImplementation(
      async (options: { readonly args?: readonly string[]; cmd: string; detached?: boolean }) =>
        options.detached === true
          ? (createMockDetachedCommand([
              { data: "/home/vercel-sandbox\n", stream: "stdout" },
            ]) as never)
          : await runCommand(options),
    );
    const { sandboxModule } = createFakeVercelProvider(templateSandbox, sessionSandbox);

    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => sandboxModule as never,
    });

    await provider.prepare({
      appRoot: "/tmp/test-app-root",
      skills: [{ content: "model skill body", relativePath: "research/SKILL.md" }],
      workspace: [
        { content: "skill body", relativePath: "skills/weather/SKILL.md" },
        { content: Buffer.from([0, 1, 2, 3]), relativePath: "assets/fixture.bin" },
      ],
    });

    await provider.prepare({
      appRoot: "/tmp/test-app-root",
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
    });

    await provider.openSession({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
    });

    expect(create).toHaveBeenCalledTimes(3);
    const [templateArgs, , sessionArgs] = create.mock.calls;
    expect(templateArgs?.[0]).toMatchObject({ timeout: 30 * 60 * 1_000 });
    expect(sessionArgs?.[0]).toMatchObject({ timeout: 30 * 60 * 1_000 });
  });

  it("mounts a Drive read-write by name, passes Drive references through, and checks the overlaid base runtime", async () => {
    class Drive {
      readonly drive = { id: "drv_team" };
      get name() {
        return "team-drive";
      }
    }
    const sessionSandbox = createMockSandbox({ name: "session" });
    const create = vi.fn().mockResolvedValue(sessionSandbox);
    const provider = vercelHarness(
      {
        loadSandboxModule: async () =>
          ({ Sandbox: { create, get: vi.fn().mockResolvedValue(null) } }) as never,
      },
      {
        mounts: {
          "/data": new Drive(),
          "/shared": { drive: "shared-drive", mode: "snapshot" },
        },
      },
    );
    await provider.openSession({
      appRoot: "/tmp/test-app-root",
      prepared: { snapshotId: "prepared-snapshot" },
      sandboxName: "session-key",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        mounts: {
          "/data": { drive: "team-drive", mode: "read-write" },
          "/shared": { drive: "shared-drive", mode: "snapshot" },
        },
      }),
    );
    expect(sessionSandbox.runCommand).toHaveBeenCalledTimes(1);
  });

  describe("identity recorded by earlier releases", () => {
    const appRoot = "/tmp/test-app-root";

    it("names session sandboxes and records their state as before", async () => {
      const fake = createFakeVercelProvider();
      const provider = createTestVercelSandbox({
        loadSandboxModule: async () => fake.sandboxModule as never,
      });

      const states = [];
      for (const sessionId of ["session_golden", "tool_session_golden"]) {
        const { state } = await provider.start({
          appRoot,
          prepared: { snapshotId: "snap_golden" },
          sandboxName: sessionId,
        });
        states.push(state);
      }

      expect(states).toEqual([
        { sandboxName: "eve-sbx-vercel-e87bbba07bceb2ae5b77ad771b299317", version: 3 },
        { sandboxName: "eve-sbx-vercel-05f9b7e93088c2627297d73f2e7e04cb", version: 3 },
      ]);
      expect(getSandboxEnvironmentRuntime(VercelSandbox.environment())).toMatchObject({
        providerName: "vercel",
        stateProtocolVersion: 1,
      });
    });

    it("records DefaultSandbox's Vercel artifact and state as before", async () => {
      vi.stubEnv("VERCEL", "1");
      vi.stubEnv("VERCEL_PROJECT_ID", "prj_golden");
      vi.stubEnv("VERCEL_TEAM_ID", "team_golden");
      vi.stubEnv("VERCEL_TOKEN", "token_golden");
      const fake = createFakeVercelProvider();
      sdk.module = fake.sandboxModule;
      const provider = createSandboxEnvironmentHarness(DefaultSandbox.environment());

      const artifact = await provider.prepare({ appRoot });
      const session = await provider.start({ appRoot, sandboxName: "session_golden" });
      const toolSession = await provider.start({ appRoot, sandboxName: "tool_session_golden" });

      expect(artifact).toEqual({ artifact: {}, provider: "vercel" });
      expect([session.state, toolSession.state]).toEqual([
        {
          provider: "vercel",
          state: { sandboxName: "eve-sbx-vercel-e87bbba07bceb2ae5b77ad771b299317", version: 3 },
          stateProtocolVersion: 1,
        },
        {
          provider: "vercel",
          state: { sandboxName: "eve-sbx-vercel-05f9b7e93088c2627297d73f2e7e04cb", version: 3 },
          stateProtocolVersion: 1,
        },
      ]);
      expect(fake.sandboxModule.Sandbox.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ snapshotExpiration: 24 * 60 * 60 * 1000 }),
      );
    });

    it("lets DefaultSandbox stop the Vercel sandbox it selected, from recorded state or from its prepared artifact", async () => {
      vi.stubEnv("VERCEL", "1");
      vi.stubEnv("VERCEL_PROJECT_ID", "prj_golden");
      vi.stubEnv("VERCEL_TEAM_ID", "team_golden");
      vi.stubEnv("VERCEL_TOKEN", "token_golden");
      const fake = createFakeVercelProvider();
      sdk.module = fake.sandboxModule;
      const provider = createSandboxEnvironmentHarness(DefaultSandbox.environment());
      await provider.prepare({ appRoot });
      const { state } = await provider.start({ appRoot, sandboxName: "session_golden" });
      const [sandbox] = fake.sandboxes.values();

      const { signal } = new AbortController();
      await provider.idleSession({ appRoot, sandboxName: "session_golden", signal, state });
      await provider.idleSession({ appRoot, sandboxName: "session_golden", signal, state: null });

      expect(sandbox?.stop).toHaveBeenCalledTimes(2);
      expect(sandbox?.stop).toHaveBeenNthCalledWith(1, { signal });
      expect(sandbox?.stop).toHaveBeenNthCalledWith(2, { signal });
      expect(fake.sandboxModule.Sandbox.create).toHaveBeenCalledOnce();
    });

    it("resumes state and a prepared snapshot recorded by an earlier release", async () => {
      const sandboxName = "eve-sbx-vercel-e87bbba07bceb2ae5b77ad771b299317";
      const fake = createFakeVercelProvider();
      fake.seedTemplate(sandboxName, createMockSandbox({ name: sandboxName, status: "stopped" }));
      const provider = createTestVercelSandbox({
        loadSandboxModule: async () => fake.sandboxModule as never,
      });
      const prepared = { snapshotId: "snap_previous_release" };

      const resumed = await provider.openSession({
        appRoot,
        existing: { sandboxName, version: 3 },
        prepared,
        sandboxName: "session_golden",
      });
      const started = await provider.start({ appRoot, prepared, sandboxName: "session_golden" });

      expect(resumed.sandbox.name).toBe(sandboxName);
      expect(started.state).toEqual({ sandboxName, version: 3 });
      expect(fake.sandboxModule.Sandbox.create).not.toHaveBeenCalled();
    });

    it("derives template keys from create options, image, resources, and source revision", async () => {
      const managedFiles = {
        resourcesKey: "resources-golden",
        skills: [{ content: "# Skill", relativePath: "golden/SKILL.md" }],
        workspace: [{ content: "notes", relativePath: "notes.md" }],
      };
      const keyFor = (input: {
        readonly createOptions?: VercelTestInput["createOptions"];
        readonly managedFiles?: typeof managedFiles;
        readonly sourceRevision?: string;
      }) =>
        templateKeyOf(async (sandboxModule) =>
          createTestVercelSandbox({
            createOptions: input.createOptions,
            loadSandboxModule: async () => sandboxModule as never,
            prepare: input.managedFiles === undefined ? async () => {} : undefined,
          }).prepare({
            appRoot,
            ...input.managedFiles,
            sourceRevision: input.sourceRevision ?? "revision-golden",
          }),
        );
      const options = {
        env: { GOLDEN: "1" },
        networkPolicy: "deny-all",
        resources: { vcpus: 4 },
        tags: { team: "golden" },
        timeout: 600_000,
      } as const;

      const keys = {
        defaults: await keyFor({}),
        managedFiles: await keyFor({ managedFiles }),
        image: await keyFor({ createOptions: { image: "registry.example/eve:golden" } }),
        source: await keyFor({
          createOptions: { source: { type: "git", url: "https://example.test/agent.git" } },
        }),
        options: await keyFor({ createOptions: options }),
        credentials: await keyFor({
          createOptions: { ...options, projectId: "prj_golden", teamId: "team_golden", token: "t" },
        }),
        sourceRevision: await keyFor({ sourceRevision: "revision-other" }),
      };

      expect(keys).toEqual({
        defaults: "eve-sbx-tpl-vercel-554ce4314fb7a0503d92d30c416064d8",
        managedFiles: "eve-sbx-tpl-vercel-d9abc1ab182ef14873f57fc00a0246c3",
        image: "eve-sbx-tpl-vercel-64eba2454d7a47c0c897d5e82b365f4f",
        source: "eve-sbx-tpl-vercel-11097efe04a48959d9420dd8ab306e12",
        options: "eve-sbx-tpl-vercel-61b688a6c98003848d40c5a13046c703",
        credentials: "eve-sbx-tpl-vercel-61b688a6c98003848d40c5a13046c703",
        sourceRevision: "eve-sbx-tpl-vercel-f638671cfec9d0a12db226863fa3ed9f",
      });
    });
  });

  describe("template key and the Vercel environment", () => {
    const keyIn = async (
      env: { readonly target?: string; readonly vercel?: string },
      rebuildable = true,
    ) => {
      vi.stubEnv("VERCEL_ENV", env.vercel);
      vi.stubEnv("VERCEL_TARGET_ENV", env.target);
      return await templateKeyOf(async (sandboxModule) =>
        createTestVercelSandbox({
          loadSandboxModule: async () => sandboxModule as never,
          prepare: async () => {},
          rebuildable,
        }).prepare({ appRoot: "/tmp/test-app-root", sourceRevision: "revision-golden" }),
      );
    };

    it("gives each Vercel environment its own template", async () => {
      const keys = [
        await keyIn({ vercel: "production" }),
        await keyIn({ vercel: "preview" }),
        await keyIn({ vercel: "development" }),
      ];
      expect(new Set(keys).size).toBe(3);
    });

    it("gives an app that is not rebuildable its own template per environment", async () => {
      const keys = [
        await keyIn({ vercel: "production" }, false),
        await keyIn({ vercel: "preview" }, false),
        await keyIn({ target: "staging", vercel: "preview" }, false),
      ];
      expect(new Set(keys).size).toBe(3);
    });

    it("gives a custom environment its own template, apart from preview", async () => {
      const preview = await keyIn({ target: "preview", vercel: "preview" });
      const staging = await keyIn({ target: "staging", vercel: "preview" });
      expect(staging).not.toBe(preview);
      expect(await keyIn({ vercel: "preview" })).toBe(preview);
    });

    it("treats an unset or blank environment alike", async () => {
      expect(await keyIn({ vercel: " preview " })).toBe(await keyIn({ vercel: "preview" }));
      expect(await keyIn({})).toBe(await keyIn({ target: "  ", vercel: "  " }));
    });
  });

  describe("session identity and cleanup", () => {
    function session() {
      const fake = createFakeVercelProvider();
      const provider = createTestVercelSandbox({
        loadSandboxModule: async () => fake.sandboxModule as never,
      });
      const start = (
        input: { readonly networkPolicy?: "deny-all"; readonly snapshotId?: string } = {},
      ) =>
        provider.start({
          appRoot: "/tmp/test-app-root",
          options: input.networkPolicy === undefined ? {} : { networkPolicy: input.networkPolicy },
          prepared: { snapshotId: input.snapshotId ?? "snapshot-a" },
          sandboxName: "session-key",
        });
      const end = (state: { readonly sandboxName: string; readonly version: 3 } | null) =>
        provider.endSession({ appRoot: "/tmp/test-app-root", sandboxName: "session-key", state });
      const idle = (
        state: { readonly sandboxName: string; readonly version: 3 } | null,
        signal?: AbortSignal,
      ) =>
        provider.idleSession({
          appRoot: "/tmp/test-app-root",
          sandboxName: "session-key",
          signal,
          state,
        });
      return { end, fake, idle, start };
    }

    it("keeps one sandbox per session key across concurrent starts, open options, and deployments", async () => {
      const { fake, start } = session();

      const [first, second] = await Promise.all([start(), start()]);
      const later = await start({ networkPolicy: "deny-all", snapshotId: "snapshot-b" });

      expect(fake.sandboxes.size).toBe(1);
      expect(second.state).toEqual(first.state);
      expect(later.state).toEqual(first.state);
    });

    it("stops a running session sandbox on idle without resuming it, and leaves a stopped or missing one alone", async () => {
      const { fake, idle, start } = session();
      const { state } = await start();
      const sandbox = fake.sandboxes.get(state.sandboxName)!;

      const { signal } = new AbortController();
      await idle(state, signal);
      expect(sandbox.stop).toHaveBeenCalledExactlyOnceWith({ signal });
      expect(fake.sandboxModule.Sandbox.get).toHaveBeenLastCalledWith(
        expect.objectContaining({ name: state.sandboxName, resume: false, signal }),
      );

      sandbox.status = "stopped";
      await idle(null);
      expect(sandbox.stop).toHaveBeenCalledOnce();

      fake.sandboxes.clear();
      await expect(idle(null)).resolves.toBeUndefined();
      expect(fake.sandboxModule.Sandbox.create).toHaveBeenCalledOnce();
    });

    it("deletes the session's sandbox by key when no state was recorded, and succeeds once it is gone", async () => {
      const { end, fake, start } = session();
      await start();

      await end(null);
      expect(fake.sandboxes.size).toBe(0);
      await expect(end(null)).resolves.toBeUndefined();
    });
  });

  describe("tool sessions", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const nameTaken = () =>
      Object.assign(new Error("A sandbox with the name already exists"), {
        response: { status: 400 },
      });

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
      expect(sandboxes.get(base)?.runCommand).not.toHaveBeenCalled();
    });

    it("adopts the fresh sandbox another instance made first after the same expiry", async () => {
      const base = await baseName();
      const sandboxes = new Map<string, ReturnType<typeof createMockSandbox>>();
      const expired = expiredSandbox(sandboxes, base);
      const { open, sandboxModule } = project(sandboxes);
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
      expect(sandboxes.get(base)?.runCommand).not.toHaveBeenCalled();
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

  describe("resuming recorded state", () => {
    const sandboxName = "eve-sbx-vercel-recorded";

    function resumeFailing(error: Error, sessionId: string) {
      const stopped = createMockSandbox({ name: sandboxName, status: "stopped" });
      stopped.runCommand.mockRejectedValue(error);
      const sandboxModule = { Sandbox: { create: vi.fn(), get: vi.fn(async () => stopped) } };
      const provider = createTestVercelSandbox({
        loadSandboxModule: async () => sandboxModule as never,
      });
      return provider.openSession({
        appRoot: "/tmp/test-app-root",
        existing: { sandboxName, version: 3 },
        prepared: { snapshotId: "prepared-snapshot" },
        sandboxName: sessionId,
      });
    }

    it("reports a session gone when its sandbox's snapshot expired", async () => {
      const error = await resumeFailing(snapshotNotFound(), "session_abc").catch((e: unknown) => e);
      expect(SandboxSessionGoneError.is(error)).toBe(true);
    });

    it.each([
      ["a stopped sandbox", 410],
      ["an internal error", 500],
    ])("surfaces %s unchanged instead of reporting the session gone", async (_, status) => {
      const original = Object.assign(new Error("Cannot resume sandbox"), {
        response: { status },
      });
      const error = await resumeFailing(original, "session_abc").catch((e: unknown) => e);
      expect(error).toBe(original);
      expect(SandboxSessionGoneError.is(error)).toBe(false);
    });
  });

  describe("shared templates", () => {
    const buildWith =
      (prepare: () => Promise<void> | void = async () => {}) =>
      async (sandboxModule: object) =>
        await createTestVercelSandbox({
          loadSandboxModule: async () => sandboxModule as never,
          prepare,
        }).prepare({ appRoot: "/tmp/test-app-root" });

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
      const second = await build(fake.sandboxModule);
      finishFirst();
      const firstResult = await first;

      const [firstSandbox, secondSandbox] = await Promise.all(privateSandboxes(fake));
      expect(firstResult).toEqual({
        snapshotId: `${firstSandbox?.name}-snapshot`,
      });
      expect(second).toEqual({
        snapshotId: `${secondSandbox?.name}-snapshot`,
      });
      expect(firstSandbox?.snapshot).toHaveBeenCalledTimes(1);
      expect(secondSandbox?.snapshot).toHaveBeenCalledTimes(1);
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
      expect(pointers).toBe(2);
    });

    it("keeps the author's tags on the published template", async () => {
      const fake = createFakeVercelProvider();

      await createTestVercelSandbox({
        createOptions: { tags: { team: "x" } },
        loadSandboxModule: async () => fake.sandboxModule as never,
      }).prepare({ appRoot: "/tmp/test-app-root" });

      expect(fake.pointer()?.tags).toEqual({ team: "x" });
    });
  });

  it("forwards author source to template create as the base layer", async () => {
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
    });

    await provider.openSession({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
    });

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

  it("captures a template only when preparation, managed files, or an authored source need one", async () => {
    const prepareWith = async (
      input: VercelTestInput,
      workspace: { content: string; relativePath: string }[] = [],
    ) => {
      const create = vi.fn(async (options: { name: string }) => createMockSandbox(options));
      const provider = vercelHarness(
        {
          ...input,
          createSandbox: async ({ createOptions }) => (await create(createOptions)) as never,
          loadSandboxModule: async () =>
            ({ Sandbox: { create, get: vi.fn().mockResolvedValue(null) } }) as never,
        },
        {},
      );
      return {
        artifact: await provider.prepare({ appRoot: "/tmp/test-app-root", workspace }),
        create,
      };
    };

    const empty = await prepareWith({ createOptions: { image: "example.test/agent:1" } });
    expect(empty.artifact).toEqual({});
    expect(empty.create).not.toHaveBeenCalled();

    const sourced = await prepareWith({
      createOptions: { source: { snapshotId: "author-snap", type: "snapshot" } },
    });
    const seeded = await prepareWith({}, [{ content: "notes", relativePath: "notes.md" }]);
    for (const { artifact } of [sourced, seeded]) {
      expect(artifact).toEqual({ snapshotId: expect.any(String) });
    }
  });

  it("gives prepare the build sandbox's name and network policy", async () => {
    const fake = createFakeVercelProvider();
    let name: string | undefined;
    await createTestVercelSandbox({
      loadSandboxModule: async () => fake.sandboxModule as never,
      prepare: async (sandbox) => {
        name = sandbox.name;
        await sandbox.setNetworkPolicy("deny-all");
      },
    }).prepare({ appRoot: "/tmp/test-app-root" });

    const build = (await fake.sandboxModule.Sandbox.create.mock.results[0]?.value) as ReturnType<
      typeof createMockSandbox
    >;
    expect(name).toBe(build.name);
    expect(name).toMatch(/^eve-sbx-tpl-vercel-[0-9a-f]{32}-[0-9a-f]{8}$/u);
    expect(build.update).toHaveBeenCalledWith({ networkPolicy: "deny-all" });
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

    await handle.connection.stop();

    expect(sessionSandbox.stop).toHaveBeenCalledTimes(1);
  });

  it("stops authored compute and keeps the Vercel session handle usable", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    vi.mocked(sessionSandbox.runCommand).mockResolvedValue(createMockDetachedCommand() as never);
    vi.mocked(sessionSandbox.runCommand).mockClear();

    await handle.connection.stop();
    await handle.sandbox.run({ command: "printf resumed" });

    expect(sessionSandbox.stop).toHaveBeenCalledTimes(1);
    expect(sessionSandbox.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["-lc", "printf resumed"], cmd: "bash" }),
    );
  });

  it("stops a Vercel session again after it resumes", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    vi.mocked(sessionSandbox.runCommand).mockResolvedValue(createMockDetachedCommand() as never);

    await handle.connection.stop();
    await handle.sandbox.run({ command: "printf resumed" });
    await handle.connection.stop();

    expect(sessionSandbox.stop).toHaveBeenCalledTimes(2);
  });

  it("stops the sandbox and asks Vercel to delete orphan snapshots when deleting it", async () => {
    const fake = createFakeVercelProvider();
    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => fake.sandboxModule as never,
    });
    const session = { appRoot: "/tmp/test-app-root", sandboxName: "session-key" };
    const handle = await provider.start({
      ...session,
      prepared: { snapshotId: "prepared-snapshot" },
    });
    const sandbox = fake.sandboxes.get(handle.sandbox.name)!;
    const abortSignal = new AbortController().signal;

    await expect(
      provider.endSession({
        ...session,
        signal: abortSignal,
        reason: "deleted",
        state: handle.state,
      }),
    ).resolves.toBeUndefined();

    expect(fake.sandboxModule.Sandbox.get).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: handle.sandbox.name, resume: false, signal: abortSignal }),
    );
    expect(sandbox.stop).toHaveBeenCalledTimes(1);
    expect(sandbox.delete).toHaveBeenCalledWith({
      deleteOrphanSnapshots: true,
      signal: abortSignal,
    });
    expect(sandbox.stop.mock.invocationCallOrder[0]).toBeLessThan(
      sandbox.delete.mock.invocationCallOrder[0]!,
    );
    expect(fake.sandboxes.size).toBe(0);
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
    });
    const handle = await provider.openSession({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
    });

    await handle.connection.stop();

    expect(sessionSandbox.stop).not.toHaveBeenCalled();
  });

  it("surfaces an authored session stop failure", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    sessionSandbox.stop.mockRejectedValueOnce(new Error("provider unreachable"));

    await expect(handle.connection.stop()).rejects.toThrow("provider unreachable");
  });

  it.each([
    ["open()", {}, { networkPolicy: "deny-all" as const }],
    ["the environment", { networkPolicy: "deny-all" as const }, {}],
  ])("creates a template-less sandbox with the policy from %s", async (_, environment, open) => {
    const sessionSandbox = createMockSandbox({ name: "session" });
    const create = vi.fn().mockResolvedValue(sessionSandbox);
    const provider = vercelHarness(
      {
        createOptions: environment,
        createSandbox: async ({ createOptions }) => {
          await create(createOptions);
          return sessionSandbox as never;
        },
        loadSandboxModule: async () =>
          ({ Sandbox: { create, get: vi.fn().mockResolvedValue(null) } }) as never,
      },
      open,
      { preparedArtifact: () => ({}) },
    );

    await provider.start({ appRoot: "/tmp/test-app-root", sandboxName: "session-key" });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ networkPolicy: "deny-all" }));
    expect(sessionSandbox.update).not.toHaveBeenCalled();
  });

  it("keeps a template-less sandbox restricted when base setup fails and is retried", async () => {
    const sessionSandbox = createMockSandbox({ name: "session" });
    const failedSetup = { ...createMockCommandResult(), exitCode: 1 };
    sessionSandbox.runCommand.mockResolvedValueOnce(failedSetup).mockResolvedValueOnce(failedSetup);
    const fake = createFakeVercelProvider(sessionSandbox);
    const provider = vercelHarness(
      {
        createSandbox: async ({ createOptions, sandboxModule }) =>
          await sandboxModule.Sandbox.create(createOptions),
        loadSandboxModule: async () => fake.sandboxModule as never,
      },
      { networkPolicy: "deny-all" },
      { preparedArtifact: () => ({}) },
    );
    const open = () =>
      provider.start({ appRoot: "/tmp/test-app-root", sandboxName: "session-key" });
    await expect(open()).rejects.toThrow("Failed to initialize Vercel sandbox base runtime.");
    expect(fake.sandboxModule.Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({ networkPolicy: "deny-all" }),
    );
    expect(fake.sandboxes.get(sessionSandbox.name)).toBe(sessionSandbox);

    await open();

    expect(fake.sandboxModule.Sandbox.create).toHaveBeenCalledTimes(1);
    expect(
      sessionSandbox.update.mock.calls.filter(([update]) => "networkPolicy" in update),
    ).toEqual([]);
  });

  it("preserves a template-less keyed session's live policy across parallel opens with changed options", async () => {
    const fake = createFakeVercelProvider();
    const provider = vercelHarness(
      {
        createSandbox: async ({ createOptions, sandboxModule }) =>
          await sandboxModule.Sandbox.create(createOptions),
        loadSandboxModule: async () => fake.sandboxModule as never,
      },
      { networkPolicy: "deny-all" },
      { preparedArtifact: () => ({}) },
    );
    const open = (options?: VercelSandboxRuntimeOptions) =>
      provider.start({ appRoot: "/tmp/test-app-root", options, sandboxName: "tool_session_abc" });
    const first = await open();
    const sessionSandbox = [...fake.sandboxes.values()][0]!;
    await first.sandbox.setNetworkPolicy({ allow: ["github.com"] });
    sessionSandbox.update.mockClear();

    const reopened = await Promise.all([
      open(),
      open({ networkPolicy: "allow-all" }),
      open({ networkPolicy: "deny-all" }),
    ]);

    expect(reopened.map(({ state }) => state)).toEqual([first.state, first.state, first.state]);
    expect(sessionSandbox.update).not.toHaveBeenCalled();

    await first.sandbox.setNetworkPolicy("allow-all");
    sessionSandbox.update.mockClear();
    const resumed = await provider.openSession({
      appRoot: "/tmp/test-app-root",
      existing: first.state,
      sandboxName: "tool_session_abc",
    });

    expect(resumed.sandbox.name).toBe(first.sandbox.name);
    expect(fake.sandboxModule.Sandbox.create).toHaveBeenCalledTimes(1);
    expect(sessionSandbox.update).not.toHaveBeenCalled();
    expect(sessionSandbox.delete).not.toHaveBeenCalled();
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

  it("runs commands in a working directory resolved from /workspace", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    vi.mocked(sessionSandbox.runCommand).mockResolvedValue(createMockDetachedCommand() as never);
    vi.mocked(sessionSandbox.runCommand).mockClear();

    await handle.sandbox.run({ command: "pwd", workingDirectory: "python-analysis" });
    await handle.sandbox.run({ command: "pwd", workingDirectory: "/tmp" });
    await handle.sandbox.run({ command: "pwd" });

    expect(sessionSandbox.runCommand.mock.calls.map(([options]) => options.cwd)).toEqual([
      "/workspace/python-analysis",
      "/tmp",
      "/workspace",
    ]);
  });

  it("kills a running command when its signal fires", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    const exited = Promise.withResolvers<void>();
    const untilExitOrAbort = (signal: AbortSignal | undefined) =>
      new Promise<void>((resolve, reject) => {
        void exited.promise.then(resolve);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const command = {
      kill: vi.fn(async () => exited.resolve()),
      async *logs(params?: { signal?: AbortSignal }) {
        yield { data: "started\n", stream: "stdout" } as const;
        await untilExitOrAbort(params?.signal).catch(() => {
          throw new DOMException("This operation was aborted", "AbortError");
        });
      },
      wait: vi.fn(async (params?: { signal?: AbortSignal }) => {
        await untilExitOrAbort(params?.signal);
        return { exitCode: 143 };
      }),
    };
    vi.mocked(sessionSandbox.runCommand).mockResolvedValueOnce(command as never);
    const controller = new AbortController();
    const stop = new Error("stop");

    const running = handle.sandbox.run({ signal: controller.signal, command: "sleep 60" });
    const settled = running.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(command.wait).toHaveBeenCalled());
    controller.abort(stop);

    await vi.waitFor(() => expect(command.kill).toHaveBeenCalledOnce());
    expect(await settled).toBe(stop);
  });

  it("converts Vercel Node file streams to the public Web stream contract", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    sessionSandbox.readFile.mockResolvedValueOnce(
      Readable.from([Buffer.from("hello "), Buffer.from("sandbox")]),
    );

    const stream = await handle.sandbox.readFile({ path: "/workspace/message.txt" });

    expect(stream).not.toBeNull();
    expect(await consumeWebStream(stream!)).toBe("hello sandbox");
    expect(sessionSandbox.readFile).toHaveBeenCalledWith(
      { path: "/workspace/message.txt" },
      { signal: undefined },
    );
  });

  it("reads existing Web file streams", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    const providerStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("web stream"));
        controller.close();
      },
    });
    sessionSandbox.readFile.mockResolvedValueOnce(providerStream);

    const stream = await handle.sandbox.readFile({ path: "/workspace/message.txt" });

    expect(stream).toBeInstanceOf(ReadableStream);
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

  it("creates with the AI_AGENT default and forwards per-command env when spawning a process", async () => {
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
    });
    const handle = await provider.openSession({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
    });

    vi.mocked(sessionSandbox.runCommand).mockResolvedValue(createMockDetachedCommand() as never);
    vi.mocked(sessionSandbox.runCommand).mockClear();

    expect(sandboxModule.Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({ env: { AI_AGENT: "eve" } }),
    );
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

  it("keeps native env, mounts, and network options when reopening a key with changed options", async () => {
    const fake = createFakeVercelProvider();
    const provider = createTestVercelSandbox({
      loadSandboxModule: async () => fake.sandboxModule as never,
    });
    const first = await provider.start({
      appRoot: "/tmp/test-app-root",
      sandboxName: "immutable-options",
      prepared: {},
      options: {
        env: { AI_AGENT: "alice-bot", REVIEW_VALUE: "initial" },
        mounts: { "/workspace/data": { drive: "initial-drive", mode: "read-write" } },
        networkPolicy: "deny-all",
      },
    });
    const created = fake.sandboxModule.Sandbox.create.mock.calls[0]![0] as MockCreateOptions & {
      env: Record<string, string>;
      mounts: object;
    };
    const sandbox = [...fake.sandboxes.values()][0]!;
    sandbox.runCommand.mockImplementation(
      async (command: { detached?: boolean; env?: Record<string, string> }) =>
        command.detached
          ? (createMockDetachedCommand([
              {
                data: JSON.stringify({ ...created.env, ...command.env }),
                stream: "stdout",
              },
            ]) as never)
          : createMockCommandResult(),
    );
    const readEnv = async (handle: { readonly sandbox: VercelSandboxSession }) =>
      JSON.parse((await handle.sandbox.run({ command: "env" })).stdout);
    expect(await readEnv(first)).toEqual({ AI_AGENT: "alice-bot", REVIEW_VALUE: "initial" });

    const reopened = await provider.start({
      appRoot: "/tmp/test-app-root",
      sandboxName: "immutable-options",
      prepared: { snapshotId: "new-deployment-template" },
      options: {
        env: { AI_AGENT: "bob-bot", REVIEW_VALUE: "changed" },
        mounts: { "/workspace/data": { drive: "changed-drive", mode: "snapshot" } },
        networkPolicy: "allow-all",
      },
    });
    const resumed = await provider.openSession({
      appRoot: "/tmp/test-app-root",
      sandboxName: "immutable-options",
      prepared: {},
      existing: first.state,
    });
    expect(await readEnv(reopened)).toEqual({
      AI_AGENT: "alice-bot",
      REVIEW_VALUE: "initial",
    });
    expect(await readEnv(resumed)).toEqual({ AI_AGENT: "alice-bot", REVIEW_VALUE: "initial" });
    const overridden = await resumed.sandbox.run({
      command: "env",
      env: { REVIEW_VALUE: "per-command" },
    });
    expect(JSON.parse(overridden.stdout)).toEqual({
      AI_AGENT: "alice-bot",
      REVIEW_VALUE: "per-command",
    });
    expect(fake.sandboxModule.Sandbox.create).toHaveBeenCalledTimes(1);
    expect(created.mounts).toEqual({
      "/workspace/data": { drive: "initial-drive", mode: "read-write" },
    });
    expect(created).toMatchObject({ networkPolicy: "deny-all" });
    expect(sandbox.update.mock.calls.filter(([update]) => "networkPolicy" in update)).toEqual([]);
  });

  it("prepares the base runtime in the template rather than its fresh snapshot-backed session", async () => {
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
    });

    await provider.openSession({
      appRoot: "/tmp/test-app-root",
      sandboxName: "session-key",
    });

    const calls = templateSandbox.runCommand.mock.calls;
    expect(calls).toHaveLength(2);

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
    expect(sessionSandbox.runCommand).not.toHaveBeenCalled();
  });

  it("checks the base runtime again after authored preparation and before capturing the snapshot", async () => {
    const template = createMockSandbox({ name: "template" });
    const prepare = vi.fn(async () => {});
    const provider = createTestVercelSandbox({
      loadSandboxModule: async () =>
        ({
          Sandbox: {
            create: createSandboxesInOrder(template),
            get: vi.fn().mockResolvedValue(null),
          },
        }) as never,
      prepare,
    });

    await provider.prepare({ appRoot: "/tmp/test-app-root" });

    expect(template.runCommand).toHaveBeenCalledTimes(2);
    const [initial, final] = template.runCommand.mock.invocationCallOrder;
    expect(initial).toBeLessThan(prepare.mock.invocationCallOrder[0]!);
    expect(final).toBeGreaterThan(prepare.mock.invocationCallOrder[0]!);
    expect(final).toBeLessThan(template.snapshot.mock.invocationCallOrder[0]!);
  });

  it("does not snapshot authored preparation that leaves the base runtime unusable", async () => {
    const template = createMockSandbox({ name: "template" });
    template.runCommand.mockResolvedValueOnce(createMockCommandResult()).mockResolvedValue({
      ...createMockCommandResult(),
      exitCode: 70,
    });
    const prepare = vi.fn(async () => {});
    const provider = createTestVercelSandbox({
      loadSandboxModule: async () =>
        ({
          Sandbox: {
            create: createSandboxesInOrder(template),
            get: vi.fn().mockResolvedValue(null),
          },
        }) as never,
      prepare,
    });

    await expect(provider.prepare({ appRoot: "/tmp/test-app-root" })).rejects.toThrow(
      "Failed to initialize Vercel sandbox base runtime",
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(template.snapshot).not.toHaveBeenCalled();
    expect(template.delete).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "custom-image"])(
    "initializes a fresh image session without a prepared snapshot (%s)",
    async (image) => {
      const session = createMockSandbox({ name: "session" });
      const provider = createTestVercelSandbox({
        createOptions: { image },
        loadSandboxModule: async () =>
          ({
            Sandbox: {
              create: vi.fn().mockResolvedValue(session),
              get: vi.fn().mockResolvedValue(null),
            },
          }) as never,
      });

      await provider.openSession({
        appRoot: "/tmp/test-app-root",
        prepared: {},
        sandboxName: "session-key",
      });

      expect(session.runCommand).toHaveBeenCalledTimes(1);
      expect(session.runCommand).toHaveBeenCalledWith(expect.objectContaining({ cmd: "bash" }));
    },
  );

  it.each([
    { image: "custom-image" },
    { source: { snapshotId: "authored-snapshot", type: "snapshot" as const } },
  ])("keeps base checks for prepared snapshots with custom sources (%j)", async (createOptions) => {
    const session = createMockSandbox({ name: "session" });
    const provider = createTestVercelSandbox({
      createOptions,
      loadSandboxModule: async () =>
        ({
          Sandbox: {
            create: vi.fn().mockResolvedValue(session),
            get: vi.fn().mockResolvedValue(null),
          },
        }) as never,
    });

    await provider.openSession({
      appRoot: "/tmp/test-app-root",
      prepared: { snapshotId: "prepared-snapshot" },
      sandboxName: "session-key",
    });

    expect(session.runCommand).toHaveBeenCalledTimes(1);
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
    });

    expect(templateSandbox.runCommand).toHaveBeenCalledTimes(3);
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
    });

    await expect(prewarm).rejects.toThrow(/Failed to initialize Vercel sandbox base runtime/);
    await expect(prewarm).rejects.not.toThrow(/Vercel OIDC can authenticate/);
  });
});

describe("Vercel active timeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    await shutdownActiveSandboxConnections();
    vi.useRealTimers();
  });

  async function runtimeSession() {
    const sessionSandbox = createMockSandbox({ name: "session" });
    const fake = createFakeVercelProvider(sessionSandbox);
    const environment = defineSandboxProvider({
      name: "vercel",
      environment: () =>
        createVercelImplementation({
          createSandbox: async ({ createOptions, sandboxModule }) =>
            sandboxModule.Sandbox.create(createOptions),
          loadSandboxModule: async () => fake.sandboxModule as never,
        }),
    }).environment();
    const access = await ensureSandboxAccess({
      compiledArtifactsSource: { kind: "bundled" },
      nodeId: "__root__",
      sessionId: "timeout-test",
      state: null,
      registry: {
        sandbox: {
          definition: {
            environment,
            kind: "independent",
            logicalPath: "sandbox.ts",
            selector: defineSandbox(() => environment.open()),
            revisionHash: "hash",
            sourceId: "sandbox",
            sourceKind: "module",
          },
          workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
        },
      },
    });
    const sandbox = await access.get();
    if (sandbox === null) throw new Error("Expected a sandbox");
    return { access, sandbox, sessionSandbox };
  }

  it.each(["release", "stop-reuse", "stop-reopen-reuse"] as const)(
    "ends renewal at scope %s without losing shutdown cleanup",
    async (lifecycle) => {
      const { access, sandbox, sessionSandbox } = await runtimeSession();
      if (lifecycle !== "release") await access.stop();
      if (lifecycle === "stop-reopen-reuse") await access.get();
      const finished = Promise.withResolvers<{ exitCode: number }>();
      const command = createMockDetachedCommand();
      command.wait.mockReturnValue(finished.promise);
      sessionSandbox.runCommand.mockResolvedValue(command);
      const process = await sandbox.spawn({ command: "train" });
      await vi.advanceTimersByTimeAsync(16 * 60_000);
      const extend = sessionSandbox.currentSession().extendTimeout;
      expect(extend).toHaveBeenCalled();
      const calls = extend.mock.calls.length;
      const stops = sessionSandbox.stop.mock.calls.length;
      await access.release();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(extend).toHaveBeenCalledTimes(calls);
      expect(sessionSandbox.stop).toHaveBeenCalledTimes(stops);
      await expect(sandbox.spawn({ command: "orphan" })).rejects.toThrow(
        "finished execution scope",
      );
      finished.resolve({ exitCode: 0 });
      await process.wait();
      await shutdownActiveSandboxConnections();
      expect(sessionSandbox.stop).toHaveBeenCalledTimes(stops + 1);
    },
  );

  it("deletes the sandbox even when an overlapping stop fails", async () => {
    const { access, sessionSandbox } = await runtimeSession();
    const stopped = Promise.withResolvers<void>();
    sessionSandbox.stop.mockReturnValueOnce(stopped.promise);
    const stopping = access.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionSandbox.stop).toHaveBeenCalledTimes(1);
    const ending = access.end("completed");
    await vi.advanceTimersByTimeAsync(0);
    const failedStop = expect(stopping).rejects.toThrow("stop failed");
    stopped.reject(new Error("stop failed"));
    await failedStop;
    await ending;
    expect(sessionSandbox.delete).toHaveBeenCalledTimes(1);
    await access.release();
  });

  async function runningCommand() {
    const { handle, sessionSandbox } = await createTestVercelSession();
    const finished = Promise.withResolvers<{ exitCode: number }>();
    const command = createMockDetachedCommand();
    command.wait.mockReturnValue(finished.promise);
    sessionSandbox.runCommand.mockResolvedValue(command);
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    const abort = new AbortController();
    const process = await handle.sandbox.spawn({ command: "train", signal: abort.signal });
    return { handle, sessionSandbox, finished, command, process, abort };
  }

  it("renews before use and throughout a long command without concurrent operations adding time twice", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    const session = sessionSandbox.currentSession();
    const extension = Promise.withResolvers<void>();
    session.extendTimeout.mockImplementationOnce(async (duration) => {
      await extension.promise;
      session.timeout += duration;
    });
    const finished = Promise.withResolvers<{ exitCode: number }>();
    const command = createMockDetachedCommand();
    command.wait.mockReturnValue(finished.promise);
    sessionSandbox.runCommand.mockResolvedValue(command);
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    const spawning = handle.sandbox.spawn({ command: "train" });
    const files = Promise.all([
      handle.sandbox.readTextFile({ path: "missing" }),
      handle.sandbox.removePath({ path: "old", force: true }),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.extendTimeout).toHaveBeenCalledTimes(1);
    extension.resolve();
    const process = await spawning;
    await files;
    await vi.advanceTimersByTimeAsync(65 * 60_000);
    expect(session.extendTimeout.mock.calls.length).toBeGreaterThan(1);
    expect(session.startedAt.getTime() + session.timeout).toBeGreaterThan(Date.now());
    finished.resolve({ exitCode: 0 });
    expect(await process.wait()).toEqual({ exitCode: 0 });
    const calls = session.extendTimeout.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(session.extendTimeout).toHaveBeenCalledTimes(calls);
    await sandboxConnectionDisposal(handle.connection)?.();
  });

  it.each(["dispose", "stop", "abort", "kill"] as const)(
    "stops renewing on %s even if command completion has not arrived",
    async (ending) => {
      const { handle, sessionSandbox, finished, process, abort } = await runningCommand();
      const extend = sessionSandbox.currentSession().extendTimeout;
      if (ending === "dispose") await sandboxConnectionDisposal(handle.connection)?.();
      if (ending === "stop") await handle.connection.stop();
      if (ending === "abort") abort.abort();
      if (ending === "kill") await process.kill();
      const calls = extend.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(extend).toHaveBeenCalledTimes(calls);
      finished.resolve({ exitCode: 0 });
      await process.wait();
      await sandboxConnectionDisposal(handle.connection)?.();
    },
  );

  it("retries a failed extension without failing the command, and never resumes a stopped session to renew", async () => {
    const { handle, sessionSandbox, finished, process } = await runningCommand();
    const session = sessionSandbox.currentSession();
    session.extendTimeout.mockRejectedValueOnce(new Error("temporary failure"));
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    expect(session.extendTimeout).toHaveBeenCalledTimes(3);
    expect(session.startedAt.getTime() + session.timeout).toBeGreaterThan(Date.now());
    session.status = "stopped";
    const calls = session.extendTimeout.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(session.extendTimeout).toHaveBeenCalledTimes(calls);
    finished.resolve({ exitCode: 0 });
    expect(await process.wait()).toEqual({ exitCode: 0 });
    await sandboxConnectionDisposal(handle.connection)?.();
  });

  it("renews for a new operation immediately after the last operation cancels an extension", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    const session = sessionSandbox.currentSession();
    session.extendTimeout.mockImplementationOnce(
      (_duration, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    await vi.advanceTimersByTimeAsync(29 * 60_000 + 50_000);
    const controller = new AbortController();
    const first = expect(
      handle.sandbox.readTextFile({ path: "missing", signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error("cancelled"));
    await handle.sandbox.removePath({ path: "old", force: true });
    await first;
    expect(session.extendTimeout).toHaveBeenCalledTimes(2);
    expect(session.startedAt.getTime() + session.timeout).toBeGreaterThan(Date.now() + 60_000);
    await sandboxConnectionDisposal(handle.connection)?.();
  });

  it("keeps a file transfer alive until the reader cancels it", async () => {
    const { handle, sessionSandbox } = await createTestVercelSession();
    const canceled = Promise.withResolvers<void>();
    const cancel = vi.fn(() => canceled.promise);
    sessionSandbox.readFile.mockResolvedValue(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        cancel,
      }),
    );
    const stream = await handle.connection.readFile({ path: "/workspace/large" });
    if (!(stream instanceof ReadableStream)) throw new Error("Expected a file stream");
    await vi.advanceTimersByTimeAsync(65 * 60_000);
    const session = sessionSandbox.currentSession();
    expect(session.startedAt.getTime() + session.timeout).toBeGreaterThan(Date.now());
    const canceling = stream.cancel();
    expect(cancel).toHaveBeenCalledOnce();
    const calls = session.extendTimeout.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(session.extendTimeout).toHaveBeenCalledTimes(calls);
    canceled.resolve();
    await canceling;
    await sandboxConnectionDisposal(handle.connection)?.();
  });

  it("aborts renewal before stopping compute and waits for stop before reusing the handle", async () => {
    const { handle, sessionSandbox, finished, process } = await runningCommand();
    let renewalSignal: AbortSignal | undefined;
    sessionSandbox.currentSession().extendTimeout.mockImplementationOnce((_duration, options) => {
      renewalSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        renewalSignal?.addEventListener("abort", () => reject(renewalSignal?.reason), {
          once: true,
        });
      });
    });
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(renewalSignal?.aborted).toBe(false);
    const stopped = Promise.withResolvers<void>();
    sessionSandbox.stop.mockImplementationOnce(async () => {
      expect(renewalSignal?.aborted).toBe(true);
      await stopped.promise;
    });
    const stopping = handle.connection.stop();
    await vi.advanceTimersByTimeAsync(0);
    const reading = handle.sandbox.readTextFile({ path: "missing" });
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionSandbox.readFile).not.toHaveBeenCalled();
    stopped.resolve();
    await stopping;
    expect(await reading).toBeNull();
    finished.resolve({ exitCode: 0 });
    await process.wait();
    await sandboxConnectionDisposal(handle.connection)?.();
  });
});

describe("scheduled template rebuilds", () => {
  const appRoot = "/tmp/test-app-root";
  const templateKey = `eve-sbx-tpl-vercel-${"a".repeat(32)}`;
  const buildSnapshotId = "build-snapshot";
  const artifact = { snapshotId: buildSnapshotId, templateKey };
  const snapshotExpired = () =>
    Object.assign(new Error("snapshot gone"), { response: { status: 410 } });

  function enforceSnapshotExpiry(fake: ReturnType<typeof createFakeVercelProvider>) {
    const create = fake.sandboxModule.Sandbox.create.getMockImplementation();
    fake.sandboxModule.Sandbox.create.mockImplementation(async (options: MockCreateOptions) => {
      const source = options.source?.snapshotId;
      if (source !== undefined && !fake.snapshots.has(source)) {
        throw snapshotExpired();
      }
      return await create!(options);
    });
  }

  function setup(createOptions?: { readonly tags: Record<string, string> }) {
    const fake = createFakeVercelProvider();
    fake.snapshots.add(buildSnapshotId);
    fake.seedTemplate(
      templateKey,
      createMockSandbox({
        name: templateKey,
        sourceSnapshotId: buildSnapshotId,
        status: "stopped",
      }),
    );
    const input = {
      createSandbox: async ({
        createOptions,
        sandboxModule,
      }: {
        createOptions: object;
        sandboxModule: { Sandbox: { create(options: never): Promise<never> } };
      }) => await sandboxModule.Sandbox.create(createOptions as never),
      loadSandboxModule: async () => fake.sandboxModule as never,
    };
    const implementation = createVercelImplementation({ ...input, createOptions } as never);
    const rebuild = getSandboxTemplateRebuilder(implementation);
    if (rebuild === undefined) throw new Error("the Vercel provider registers no rebuilder");
    const provider = createTestVercelSandbox({ ...input, createOptions } as never);
    const sessionSource = async (sandboxName: string) => {
      await provider.start({ appRoot, prepared: artifact, sandboxName });
      const created = fake.sandboxModule.Sandbox.create.mock.calls.at(-1)?.[0] as {
        source?: { snapshotId: string };
      };
      return created.source?.snapshotId;
    };
    return { fake, provider, rebuild, sessionSource };
  }

  it("records the template key in the artifact only when the sandbox is rebuildable", async () => {
    const prepareWith = async (rebuildable: boolean) => {
      const fake = createFakeVercelProvider();
      const provider = createVercelSandbox({
        createSandbox: async ({ createOptions, sandboxModule }) =>
          await sandboxModule.Sandbox.create(createOptions),
        loadSandboxModule: async () => fake.sandboxModule as never,
        rebuildable,
      });
      const prepared = (await provider.prepare({ appRoot })) as VercelSandboxPreparedArtifact;
      return { fake, prepared };
    };

    const rebuildable = await prepareWith(true);
    expect(rebuildable.prepared.templateKey).toBe(rebuildable.fake.pointer()?.name);
    expect((await prepareWith(false)).prepared).toEqual({ snapshotId: expect.any(String) });
  });

  it("makes no pointer lookup for a build that is not rebuildable", async () => {
    const { fake, provider } = setup();
    await provider.start({
      appRoot,
      prepared: { snapshotId: buildSnapshotId },
      sandboxName: "session-plain",
    });

    const lookedUp = fake.sandboxModule.Sandbox.get.mock.calls.map(
      ([options]) => (options as { name: string }).name,
    );
    expect(lookedUp).not.toContain(templateKey);
  });

  it("opens from the build snapshot when the pointer lookup fails", async () => {
    const { fake, rebuild, sessionSource } = setup();
    await rebuild(artifact, { prepare: async () => {}, revision: "rev-1" });
    const get = fake.sandboxModule.Sandbox.get.getMockImplementation();
    fake.sandboxModule.Sandbox.get.mockImplementation(async (options: { name: string }) => {
      if (options.name === templateKey) {
        throw Object.assign(new Error("unavailable"), { response: { status: 503 } });
      }
      return await get!(options);
    });

    expect(await sessionSource("session-lookup-failed")).toBe(buildSnapshotId);
  });

  it("keeps the author's tags next to the revision on the rebuilt pointer", async () => {
    const { fake, rebuild } = setup({ tags: { team: "x" } });

    await rebuild(artifact, { prepare: async () => {}, revision: "rev-1" });

    expect(fake.pointer()?.tags).toEqual({ team: "x", "eve-template-revision": "rev-1" });
  });

  it("puts the previous pointer back when publishing the new one fails", async () => {
    const { fake, rebuild } = setup();
    const create = fake.sandboxModule.Sandbox.create.getMockImplementation();
    fake.sandboxModule.Sandbox.create.mockImplementation(async (options: MockCreateOptions) => {
      if (
        TEMPLATE_POINTER_NAME.test(options.name) &&
        options.source?.snapshotId !== buildSnapshotId
      ) {
        throw new Error("create failed");
      }
      return await create!(options);
    });

    await expect(rebuild(artifact, { prepare: async () => {}, revision: "rev-1" })).rejects.toThrow(
      "create failed",
    );

    expect(fake.pointer()?.sourceSnapshotId).toBe(buildSnapshotId);
    expect(fake.snapshots.has(buildSnapshotId)).toBe(true);
  });

  it("says how to make a sandbox rebuildable when the build did not", async () => {
    const { rebuild } = setup();

    await expect(
      rebuild({ snapshotId: buildSnapshotId }, { prepare: async () => {}, revision: "rev-1" }),
    ).rejects.toThrow("rebuildable: true");
  });

  it("opens new sessions from the build snapshot until a rebuild publishes a newer one", async () => {
    const { fake, rebuild, sessionSource } = setup();
    expect(await sessionSource("session-before")).toBe(buildSnapshotId);

    await rebuild(artifact, { prepare: async () => {}, revision: "rev-1" });

    const rebuilt = fake.pointer()?.sourceSnapshotId;
    expect(rebuilt).not.toBe(buildSnapshotId);
    expect(await sessionSource("session-after")).toBe(rebuilt);
  });

  it("publishes the pointer with the revision and keeps every earlier snapshot", async () => {
    const { fake, rebuild } = setup();
    const prepare = vi.fn(async () => {});

    expect(await rebuild(artifact, { prepare, revision: "rev-1" })).toEqual({ rebuilt: true });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(fake.pointer()?.tags).toEqual({ "eve-template-revision": "rev-1" });
    const firstSnapshot = fake.pointer()?.sourceSnapshotId as string;
    expect(firstSnapshot).not.toBe(buildSnapshotId);

    expect(await rebuild(artifact, { prepare, revision: "rev-2" })).toEqual({ rebuilt: true });
    expect(fake.pointer()?.tags).toEqual({ "eve-template-revision": "rev-2" });
    expect(fake.snapshots.has(buildSnapshotId)).toBe(true);
    expect(fake.snapshots.has(firstSnapshot)).toBe(true);
    expect(fake.snapshots.has(fake.pointer()?.sourceSnapshotId as string)).toBe(true);
  });

  it("keeps the snapshot a newer deployment reused as its fallback after an older deployment rebuilds", async () => {
    const { fake, rebuild } = setup();
    await rebuild(artifact, { prepare: async () => {}, revision: "rev-1" });
    const reused = fake.pointer()?.sourceSnapshotId as string;

    await rebuild(artifact, { prepare: async () => {}, revision: "rev-2" });

    expect(fake.snapshots.has(reused)).toBe(true);
  });

  it("rebuilds from the build snapshot when the pointer's snapshot has expired", async () => {
    const { fake, rebuild, sessionSource } = setup();
    await rebuild(artifact, { prepare: async () => {}, revision: "rev-1" });
    const expired = fake.pointer()?.sourceSnapshotId as string;
    fake.snapshots.delete(expired);
    enforceSnapshotExpiry(fake);

    expect(await rebuild(artifact, { prepare: async () => {}, revision: "rev-1" })).toEqual({
      rebuilt: true,
    });

    const rebuilt = fake.pointer()?.sourceSnapshotId as string;
    expect(rebuilt).not.toBe(expired);
    expect(fake.snapshots.has(rebuilt)).toBe(true);
    expect(await sessionSource("session-after")).toBe(rebuilt);
  });

  it("says why an environment without a snapshot cannot be rebuilt", async () => {
    const { rebuild } = setup();

    await expect(rebuild({}, { prepare: async () => {}, revision: "rev-1" })).rejects.toThrow(
      "no snapshot to rebuild",
    );
  });

  it("asks for a redeploy when no snapshot of the template is left", async () => {
    const { fake, rebuild } = setup();
    fake.snapshots.clear();
    enforceSnapshotExpiry(fake);

    await expect(
      rebuild(artifact, { prepare: async () => {}, revision: "rev-1" }),
    ).rejects.toBeInstanceOf(SandboxTemplateNotProvisionedError);
  });

  it("starts nothing when the template already has the revision", async () => {
    const { fake, rebuild } = setup();
    await rebuild(artifact, { prepare: async () => {}, revision: "rev-1" });
    const created = fake.sandboxModule.Sandbox.create.mock.calls.length;
    const prepare = vi.fn(async () => {});

    expect(await rebuild(artifact, { prepare, revision: "rev-1" })).toEqual({ rebuilt: false });

    expect(prepare).not.toHaveBeenCalled();
    expect(fake.sandboxModule.Sandbox.create.mock.calls.length).toBe(created);
  });

  it("leaves the pointer and snapshots alone when prepare fails", async () => {
    const { fake, rebuild, sessionSource } = setup();
    const snapshotsBefore = new Set(fake.snapshots);

    await expect(
      rebuild(artifact, {
        prepare: async () => {
          throw new Error("install failed");
        },
        revision: "rev-1",
      }),
    ).rejects.toThrow("install failed");

    expect(fake.pointer()?.sourceSnapshotId).toBe(buildSnapshotId);
    expect(fake.pointer()?.tags).toBeUndefined();
    expect(fake.snapshots).toEqual(snapshotsBefore);
    expect([...fake.sandboxes.keys()]).toEqual([templateKey]);
    expect(await sessionSource("session-after")).toBe(buildSnapshotId);
  });

  it("runs one rebuild at a time", async () => {
    const { rebuild } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = rebuild(artifact, { prepare: () => gate, revision: "rev-1" });
    await vi.waitFor(() => undefined);

    const second = await rebuild(artifact, { prepare: async () => {}, revision: "rev-2" });
    release();

    expect(second).toEqual({ rebuilt: false });
    expect(await first).toEqual({ rebuilt: true });
  });

  it("keeps the published snapshot when stopping the new pointer fails", async () => {
    const { fake, rebuild, sessionSource } = setup();
    const create = fake.sandboxModule.Sandbox.create.getMockImplementation();
    fake.sandboxModule.Sandbox.create.mockImplementation(async (options: MockCreateOptions) => {
      const sandbox = await create!(options);
      if (TEMPLATE_POINTER_NAME.test(options.name)) {
        sandbox.stop.mockRejectedValue(new Error("stop failed"));
      }
      return sandbox;
    });

    expect(await rebuild(artifact, { prepare: async () => {}, revision: "rev-1" })).toEqual({
      rebuilt: true,
    });

    const published = fake.pointer()?.sourceSnapshotId as string;
    expect(published).not.toBe(buildSnapshotId);
    expect(fake.snapshots.has(published)).toBe(true);
    expect(await sessionSource("session-after")).toBe(published);
  });

  it("discards its snapshot when another process published first", async () => {
    const { fake, rebuild } = setup();
    const result = await rebuild(artifact, {
      prepare: async () => {
        fake.sandboxes.get(templateKey)?.delete();
        await fake.sandboxModule.Sandbox.create({
          name: templateKey,
          source: { snapshotId: "other-process-snapshot", type: "snapshot" },
        });
      },
      revision: "rev-1",
    });

    expect(result).toEqual({ rebuilt: false });
    expect(fake.pointer()?.sourceSnapshotId).toBe("other-process-snapshot");
    expect([...fake.snapshots].filter((id) => id.startsWith(templateKey))).toEqual([]);
  });

  it("falls back to the build snapshot when the pointer's snapshot is gone", async () => {
    const { fake, rebuild, sessionSource } = setup();
    await rebuild(artifact, { prepare: async () => {}, revision: "rev-1" });
    const pointerSnapshot = fake.pointer()?.sourceSnapshotId as string;
    const create = fake.sandboxModule.Sandbox.create.getMockImplementation();
    fake.sandboxModule.Sandbox.create.mockImplementation(async (options: MockCreateOptions) => {
      if (
        options.source?.snapshotId === pointerSnapshot &&
        !TEMPLATE_POINTER_NAME.test(options.name)
      ) {
        throw snapshotExpired();
      }
      return await create!(options);
    });

    expect(await sessionSource("session-after")).toBe(buildSnapshotId);
  });

  it("keeps resumed sessions on their own sandbox", async () => {
    const { fake, provider, rebuild } = setup();
    const { state } = await provider.start({
      appRoot,
      prepared: artifact,
      sandboxName: "session-1",
    });
    const created = fake.sandboxModule.Sandbox.create.mock.calls.length;

    await rebuild(artifact, { prepare: async () => {}, revision: "rev-1" });
    await provider.openSession({
      appRoot,
      existing: state,
      prepared: artifact,
      sandboxName: "session-1",
    });

    const sessionCreates = fake.sandboxModule.Sandbox.create.mock.calls
      .slice(created)
      .filter(([options]) => (options as { name: string }).name.startsWith("eve-sbx-vercel-"));
    expect(sessionCreates).toEqual([]);
  });
});
