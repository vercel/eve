import type { Experimental_SandboxSession } from "ai";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type * as Vercel from "#compiled/@vercel/sandbox/index.js";
import {
  createSandboxPrepareContext,
  type SandboxTemplateResources,
} from "#execution/sandbox/prewarm.js";
import { defineSandboxProvider, type SandboxConnection } from "#sandbox/provider.js";
import {
  getSandboxEnvironmentRuntime,
  type SandboxEnvironmentIdentity,
} from "#shared/sandbox-environment.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

const HOME_PROBE = `printf '%s\\n' "$HOME"`;

/** A connection that records what eve sends it and answers the `$HOME` probe. */
function recordingConnection() {
  const files = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const connection = {
    extensions: { ping: async () => "pong" },
    async readFile({ path }: { readonly path: string }) {
      return files.get(path) ?? null;
    },
    removePath: vi.fn(async () => {}),
    spawn: vi.fn(async (options: Parameters<SandboxConnection["spawn"]>[0]) => ({
      kill: async () => {},
      stderr: new Blob([]).stream(),
      stdout: new Blob([options.command === HOME_PROBE ? "/home/agent\n" : ""]).stream(),
      wait: async () => ({ exitCode: 0 }),
    })),
    stop: vi.fn(async () => {}),
    writeFiles: vi.fn(
      async (options: { readonly files: readonly { content: Uint8Array; path: string }[] }) => {
        calls.push(`write ${options.files.map((file) => file.path).join(" ")}`);
        for (const file of options.files) files.set(file.path, file.content);
      },
    ),
  };
  return { calls, connection, files };
}

/** Runs the environment's `prepare()` with the context eve builds during `eve build`. */
async function prepare(
  environment: SandboxEnvironmentIdentity,
  resources: Omit<SandboxTemplateResources, "key"> = {},
) {
  const runtime = getSandboxEnvironmentRuntime(environment);
  return await runtime.implementation.prepare(
    createSandboxPrepareContext({
      appRoot: "/app",
      files: { list: async () => [], read: vi.fn(), readText: vi.fn() },
      log: () => {},
      provider: runtime,
      resources: { key: "resources-key", ...resources },
      sourceRevision: "revision-1",
      storagePath: "/app/.eve/sandbox",
    }),
  );
}

/** A provider whose `prepare` populates `connection`, passing `mountedAt` through. */
function bakingProvider(
  connection: SandboxConnection<{ ping(): Promise<string> }>,
  mountedAt?: string,
) {
  return defineSandboxProvider({
    name: "baking",
    environment: () => ({
      async prepare(ctx) {
        if (!ctx.isEmpty) await ctx.populate(connection, { mountedAt });
        return { empty: ctx.isEmpty };
      },
      start: async () => ({ connection, state: null }),
      resume: async () => connection,
      onSessionEnd: async () => {},
    }),
  });
}

describe("defineSandboxProvider", () => {
  it("passes environment options to the provider without prepare, and {} when omitted", () => {
    const received: object[] = [];
    const provider = defineSandboxProvider({
      name: "options",
      environment(options: { readonly region?: string }) {
        received.push(options);
        return {
          prepare: async () => null,
          start: async () => ({ connection: recordingConnection().connection, state: null }),
          resume: async () => recordingConnection().connection,
          onSessionEnd: async () => {},
        };
      },
    });

    provider.environment();
    provider.environment({ prepare: async () => {} });
    provider.environment({ prepare: async () => {}, region: "iad1" });

    expect(received).toEqual([{}, {}, { region: "iad1" }]);
  });

  it("hashes template identities with the workspace, skills, and source revision", async () => {
    const keys: string[] = [];
    const provider = defineSandboxProvider({
      name: "keys",
      environment: () => ({
        async prepare(ctx) {
          keys.push(ctx.templateKey({ image: "ubuntu", skip: undefined, version: 1 }));
          expect(() => ctx.templateKey({ sourceRevision: "mine" })).toThrow(
            'ctx.templateKey() reserves "sourceRevision"',
          );
          // These would hash like `{}` or overflow the stack, so they reject.
          expect(() => ctx.templateKey({ builtAt: new Date(0) })).toThrow(
            "but identity.builtAt is a Date",
          );
          expect(() => ctx.templateKey({ layers: [new Map()] })).toThrow(
            "but identity.layers[0] is a Map",
          );
          const loop: unknown[] = [];
          loop.push(loop);
          expect(() => ctx.templateKey({ loop })).toThrow("circular value at identity.loop[0]");
          return null;
        },
        start: async () => ({ connection: recordingConnection().connection, state: null }),
        resume: async () => recordingConnection().connection,
        onSessionEnd: async () => {},
      }),
    });
    await prepare(provider.environment());

    // Golden value: if it changes, every custom provider's template keys change with it.
    expect(keys).toEqual(["d02550d7328ec5806580c8cd02c0c2b0b3e9a90bbbec7f552938442d79ffd8e1"]);
  });

  it("seeds workspace and skills in one batch before the authored prepare", async () => {
    const { calls, connection } = recordingConnection();
    const provider = bakingProvider(connection);
    const environment = provider.environment({
      prepare: async (sandbox) => {
        await sandbox.writeTextFile({ content: await sandbox.ping(), path: "prepared.txt" });
      },
    });

    const artifacts = [
      await prepare(environment, {
        skills: [{ content: "# Skill", relativePath: "review/SKILL.md" }],
        workspace: [
          { content: "seed", relativePath: "seed.txt" },
          { content: "literal", relativePath: "$HOME/notes.txt" },
        ],
      }),
      await prepare(provider.environment()),
    ];

    expect(artifacts).toEqual([{ empty: false }, { empty: true }]);
    expect(calls).toEqual([
      "write /workspace/seed.txt /workspace/$HOME/notes.txt /home/agent/.agents/skills/review/SKILL.md",
      "write /workspace/prepared.txt",
    ]);
  });

  it("seeds the connection's workspace root from mounted resources, or by writing files without a resource directory", async () => {
    const seed = { workspace: [{ content: "seed", relativePath: "seed.txt" }] };
    const mounted = recordingConnection();
    const mountedConnection = { ...mounted.connection, workspaceRoot: "/srv/app" };
    await prepare(bakingProvider(mountedConnection, "/eve/res ources").environment(), {
      ...seed,
      path: "/app/.eve/compile/resources",
    });
    const inline = recordingConnection();
    const inlineConnection = { ...inline.connection, workspaceRoot: "/srv/app" };
    await prepare(bakingProvider(inlineConnection, "/eve/resources").environment(), seed);

    expect(mounted.calls).toEqual([]);
    const copy = mounted.connection.spawn.mock.calls[0]?.[0].command;
    expect(copy).toContain("cp -a '/eve/res ources'/workspace/. '/srv/app'/");
    expect(copy).toContain(`cp -a '/eve/res ources'/skills/. "$HOME/.agents/skills/"`);
    expect(inline.calls).toEqual(["write /srv/app/seed.txt"]);
  });
});

describe("public sandbox types", () => {
  it("infers a provider's options, state, and extensions from its implementation", () => {
    type Extensions = { setNetworkPolicy(policy: "deny-all"): Promise<void> };
    const provider = defineSandboxProvider({
      name: "acme",
      environment(options: { readonly project: string }) {
        return {
          prepare: async (ctx) => ({ snapshotId: ctx.templateKey({ project: options.project }) }),
          async start(_ctx, open: { readonly egress?: "deny-all" } | undefined) {
            return { connection: connect(), state: { name: String(open?.egress), version: 1 } };
          },
          async resume(_ctx, artifact, state) {
            expectTypeOf(artifact.snapshotId).toEqualTypeOf<string>();
            expectTypeOf(state.name).toEqualTypeOf<string>();
            return connect();
          },
          onSessionEnd: async () => {},
        };
      },
    });
    function connect(): SandboxConnection<Extensions> {
      throw new Error("type-only");
    }
    const environment = provider.environment({
      prepare: (sandbox) => {
        expectTypeOf(sandbox).toEqualTypeOf<SandboxSession & Extensions>();
      },
      project: "agents",
    });

    expectTypeOf(environment.open).toBeCallableWith({ egress: "deny-all" });
    // @ts-expect-error The provider's open options accept only "deny-all".
    void (() => environment.open({ egress: "allow-all" }));
    const colliding: SandboxConnection<{ run(): Promise<string> }> = {
      ...recordingConnection().connection,
      // @ts-expect-error `run` belongs to the session eve derives.
      extensions: { run: async () => "mine" },
    };
    void colliding;
  });

  it("keeps SandboxSession assignable to the AI SDK sandbox session", () => {
    expectTypeOf<SandboxSession>().toExtend<Omit<Experimental_SandboxSession, "description">>();
  });

  it("keeps SandboxNetworkPolicy within the Vercel Sandbox network policy shape", () => {
    type Writable<T> = T extends (...args: never[]) => unknown
      ? T
      : T extends object
        ? { -readonly [Key in keyof T]: Writable<T[Key]> }
        : T;
    expectTypeOf<Writable<SandboxNetworkPolicy>>().toExtend<Vercel.NetworkPolicy>();
  });
});
