import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApprovalPolicy } from "#approval/definition.js";
import type { SessionAuthContext } from "#channel/types.js";
import { shutdownActiveSandboxConnections } from "#execution/sandbox/active-connections.js";
import { invokeTool, type InvokeToolRuntime } from "#execution/invoke-tool.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { defineSandboxProvider, type SandboxConnection } from "#sandbox/provider.js";
import type { ToolContext } from "#tools/definition.js";
import { defineJsonSchema } from "#tools/schema.js";

vi.mock("#runtime/sandbox/prepared-artifacts.js", () => ({
  loadSandboxPreparedArtifact: vi.fn(async () => null),
}));

afterEach(() => shutdownActiveSandboxConnections());

const alice: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};

const inputSchema = defineJsonSchema({
  additionalProperties: false,
  properties: { text: { type: "string" } },
  type: "object",
});

function tool(
  name: string,
  execute: (input: any, ctx: ToolContext) => unknown,
  extra: Partial<HarnessToolDefinition> = {},
): HarnessToolDefinition {
  return {
    description: name,
    execute: createToolExecuteWithAuth({ execute, scope: name }),
    inputSchema,
    name,
    ...extra,
  };
}

/** A connection over an in-memory sandbox; `stop` and `close` are spies. */
function connect(sandbox: ReturnType<typeof mockSandbox>, stop = vi.fn(async () => {})) {
  const { session } = sandbox;
  return {
    readFile: (options: { readonly path: string }) => session.readBinaryFile(options),
    removePath: session.removePath,
    spawn: session.spawn,
    stop,
    writeFiles: session.writeFiles,
  } satisfies SandboxConnection;
}

function registryFor(
  environment: ReturnType<ReturnType<typeof defineSandboxProvider>["environment"]>,
  options: { readonly failSelector?: () => boolean } = {},
): RuntimeSandboxRegistry {
  return {
    sandbox: {
      definition: {
        environment,
        kind: "independent",
        logicalPath: "sandbox.ts",
        revisionHash: "hash",
        selector: defineSandbox(async () => {
          const sandbox = await environment.open();
          if (options.failSelector?.() === true) throw new Error("selector failed");
          return sandbox;
        }),
        sourceId: "sandbox",
        sourceKind: "module",
      },
      workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
    },
  };
}

/** A provider that keeps each call's sandbox under its session id; `deleted` records cleanup by id. */
function sandboxes(
  options: { readonly closeError?: Error; readonly startGate?: Promise<void> } = {},
) {
  const started: string[] = [];
  const deleted = vi.fn(async (_sessionId: string, _reason: string) => {});
  const shutdown = vi.fn(async () => {});
  const closed = vi.fn(async () => {
    if (options.closeError !== undefined) throw options.closeError;
  });
  const environment = defineSandboxProvider({
    name: "memory",
    environment: () => ({
      onSessionEnd: async (context, _state, { reason }) => deleted(context.session.id, reason),
      prepare: async () => null,
      resume: async () => {
        throw new Error("a call's sandbox is never resumed");
      },
      async start(context) {
        started.push(context.session.id);
        await options.startGate;
        return { connection: { ...connect(mockSandbox(), shutdown), close: closed }, state: null };
      },
    }),
  }).environment();
  return { closed, deleted, registry: registryFor(environment), shutdown, started };
}

/**
 * A provider whose `start` is an upsert on the session id and that sets
 * `toolSessions`, as Vercel Sandbox and just-bash do. Each open hands out its
 * own connection over the shared sandbox, as just-bash runs one interpreter
 * per connection; `released` records which connections a call closed, and
 * `stopped` any stop through the sandbox API or at server shutdown.
 */
function keyedSandboxes(options: { readonly failSelector?: () => boolean } = {}) {
  const live = new Map<string, ReturnType<typeof mockSandbox>>();
  const starts: string[] = [];
  const kinds: string[] = [];
  const handles: object[] = [];
  const released: object[] = [];
  const stopped = vi.fn(async () => {});
  const deleted = vi.fn((sessionId: string) => void live.delete(sessionId));
  const reopen = (sessionId: string) => {
    let sandbox = live.get(sessionId);
    if (sandbox === undefined) {
      starts.push(sessionId);
      sandbox = mockSandbox();
      live.set(sessionId, sandbox);
    }
    const connection = {
      ...connect(sandbox, stopped),
      close: async () => void released.push(connection),
    };
    handles.push(connection);
    return connection;
  };
  const environment = defineSandboxProvider({
    name: "keyed",
    environment: () => ({
      onSessionEnd: async (context) => deleted(context.session.id),
      prepare: async () => null,
      resume: async (context) => reopen(context.session.id),
      async start(context) {
        kinds.push(context.kind);
        return { connection: reopen(context.session.id), state: {} };
      },
      toolSessions: true,
    }),
  }).environment();
  return {
    deleted,
    handles,
    kinds,
    live,
    registry: registryFor(environment, options),
    released,
    starts,
    stopped,
  };
}

/** A tool that appends to a note in its sandbox and returns the note, after `gate` opens. */
function noteTool(gate: Promise<void> = Promise.resolve()) {
  return tool("note", async (input: { text: string }, ctx) => {
    const sandbox = await ctx.getSandbox();
    await gate;
    const previous = await sandbox.readTextFile({ path: "/workspace/note.txt" });
    const note = (previous ?? "") + input.text;
    await sandbox.writeTextFile({ content: note, path: "/workspace/note.txt" });
    return note;
  });
}

function runtimeWith(
  tools: readonly HarnessToolDefinition[],
  registry = sandboxes().registry,
  owners: Readonly<Record<string, "application" | "framework">> = {},
): InvokeToolRuntime {
  return {
    agentName: "test-agent",
    callbackBaseUrl: "https://agent.example",
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    manifest: {
      bindings: Object.fromEntries(
        tools.map(({ name }) => [
          `source:${name}`,
          { owner: { kind: owners[name] ?? "application" } } as never,
        ]),
      ),
      tools: tools.map(({ name }) => ({ hasExecute: true, name, sourceId: `source:${name}` })),
    },
    nodeId: "__root__",
    sandboxRegistry: registry,
    tools: new Map(tools.map((definition) => [definition.name, definition])),
  };
}

describe("invokeTool", () => {
  it("runs as auth, with initiator defaulting to auth", async () => {
    const bob: SessionAuthContext = { ...alice, principalId: "bob" };
    const seen: unknown[] = [];
    const runtime = runtimeWith([
      tool("whoami", (_input, ctx) => {
        seen.push({ ...ctx.session.auth });
        return "ok";
      }),
    ]);
    await invokeTool(runtime, "whoami", {}, { auth: alice });
    await invokeTool(runtime, "whoami", {}, { auth: alice, initiator: bob });
    expect(seen).toEqual([
      { current: alice, initiator: alice },
      { current: alice, initiator: bob },
    ]);
  });

  it("evaluates the approval policy and never asks anyone", async () => {
    const policies: Array<[ApprovalPolicy, object, boolean]> = [
      [() => "user-approval", { status: "approval-required" }, false],
      [
        () => ({ reason: "Read-only mode.", type: "denied" }),
        { reason: "Read-only mode.", status: "denied" },
        false,
      ],
      [() => "not-applicable", { output: "ran", status: "completed" }, true],
    ];
    for (const [approval, expected, ran] of policies) {
      const execute = vi.fn(() => "ran");
      const runtime = runtimeWith([tool("deploy", execute, { approval })]);
      expect(await invokeTool(runtime, "deploy", {}, { auth: alice })).toMatchObject(expected);
      expect(execute).toHaveBeenCalledTimes(ran ? 1 : 0);
    }
  });

  it("refuses unknown, framework, and badly typed calls before running anything", async () => {
    const execute = vi.fn();
    const runtime = runtimeWith([tool("note", execute), tool("web_fetch", execute)], undefined, {
      web_fetch: "framework",
    });
    expect(await invokeTool(runtime, "missing", {}, { auth: alice })).toMatchObject({
      message: 'The agent has no tool named "missing".',
      status: "failed",
    });
    expect(await invokeTool(runtime, "web_fetch", {}, { auth: alice })).toMatchObject({
      message: expect.stringContaining("framework tool"),
      status: "failed",
    });
    expect(await invokeTool(runtime, "note", { text: 7 }, { auth: alice })).toMatchObject({
      status: "invalid-input",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("checks input as a conversation does: none is {}, and a non-object is refused", async () => {
    const execute = vi.fn((input: unknown) => input);
    const runtime = runtimeWith([tool("note", execute)]);
    for (const input of [[1], "plain", 7, true]) {
      expect(await invokeTool(runtime, "note", input, { auth: alice })).toMatchObject({
        message: expect.stringContaining('Invalid input for tool "note"'),
        status: "invalid-input",
      });
    }
    expect(execute).not.toHaveBeenCalled();
    for (const input of [undefined, null, ""]) {
      expect(await invokeTool(runtime, "note", input, { auth: alice })).toMatchObject({
        output: {},
        status: "completed",
      });
    }
  });

  it("gives each call its own sandbox and deletes it when the call ends", async () => {
    const { deleted, registry, shutdown, started } = sandboxes();
    const write = tool("write", async (input: { text: string }, ctx) => {
      const sandbox = await ctx.getSandbox();
      await sandbox.writeTextFile({ content: input.text, path: "/workspace/note.txt" });
      return ctx.session.auth.current?.principalId;
    });
    const plain = tool("plain", () => "no sandbox");
    const runtime = runtimeWith([write, plain], registry);

    expect(await invokeTool(runtime, "write", { text: "a" }, { auth: alice })).toMatchObject({
      output: "alice",
      status: "completed",
    });
    await invokeTool(runtime, "write", { text: "b" }, { auth: alice });
    await invokeTool(runtime, "plain", {}, { auth: alice });

    expect(started).toHaveLength(2);
    expect(started[0]).not.toBe(started[1]);
    expect(deleted).toHaveBeenCalledTimes(2);
    await shutdownActiveSandboxConnections();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("maps sandbox.stop() onto the connection and sandbox.delete() onto onSessionEnd", async () => {
    const { closed, deleted, registry, shutdown } = sandboxes();
    const runtime = runtimeWith(
      [
        tool("open", async (_input: unknown, ctx) => void (await ctx.getSandbox())),
        tool("pause", async (_input: unknown, ctx) => await (await ctx.getSandbox()).stop()),
        tool("discard", async (_input: unknown, ctx) => await (await ctx.getSandbox()).delete()),
      ],
      registry,
    );
    const reasons = () => deleted.mock.calls.map(([, reason]) => reason);

    // Session end closes what this process holds for the call's connection.
    expect(await invokeTool(runtime, "open", {}, { auth: alice })).toMatchObject({
      status: "completed",
    });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(reasons()).toEqual(["completed"]);

    // A call that stopped and then ended its sandbox leaves nothing for shutdown to stop.
    expect(await invokeTool(runtime, "pause", {}, { auth: alice })).toMatchObject({
      status: "completed",
    });
    await shutdownActiveSandboxConnections();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledTimes(2);

    expect(await invokeTool(runtime, "discard", {}, { auth: alice })).toMatchObject({
      status: "completed",
    });
    expect(closed).toHaveBeenCalledTimes(3);
    expect(reasons()).toEqual(["completed", "completed", "deleted", "completed"]);
  });

  it("deletes the sandbox even when closing the connection fails", async () => {
    const { deleted, registry } = sandboxes({ closeError: new Error("interpreter stuck") });
    const runtime = runtimeWith(
      [tool("discard", async (_input: unknown, ctx) => await (await ctx.getSandbox()).delete())],
      registry,
    );

    expect(await invokeTool(runtime, "discard", {}, { auth: alice })).toMatchObject({
      status: "failed",
    });
    expect(deleted.mock.calls.map(([, reason]) => reason)).toEqual(["deleted", "completed"]);
  });

  it("deletes a sandbox whose start finishes after the call failed", async () => {
    let finishStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    const { deleted, registry, shutdown, started } = sandboxes({ startGate });
    let gaveUp = false;
    const racing = tool("racing", async (_input: unknown, ctx) => {
      // The call gives up while the provider is still starting, as a lost
      // race against cancellation would.
      void ctx.getSandbox().catch(() => {});
      await vi.waitFor(() => expect(started).toHaveLength(1));
      gaveUp = true;
      throw new Error("gave up");
    });
    const runtime = runtimeWith([racing], registry);

    const result = invokeTool(runtime, "racing", {}, { auth: alice });
    await vi.waitFor(() => expect(gaveUp).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deleted).not.toHaveBeenCalled();
    finishStart();
    // Let a start that outlived the call settle before checking what it left behind.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await result).toMatchObject({ status: "failed" });
    expect(deleted).toHaveBeenCalledTimes(1);
    await shutdownActiveSandboxConnections();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("keeps one sandbox per caller and key across calls", async () => {
    const { deleted, registry, starts } = keyedSandboxes();
    const runtime = runtimeWith([noteTool()], registry);
    const note = (text: string, auth: SessionAuthContext, key: string) =>
      invokeTool(runtime, "note", { text }, { auth, key });

    // Concurrent first calls converge on one sandbox; later calls reuse it.
    const first = await Promise.all([note("a", alice, "desk"), note("b", alice, "desk")]);
    expect(first.map((result) => result.status)).toEqual(["completed", "completed"]);
    expect(starts).toHaveLength(1);
    expect(await note("c", alice, "desk")).toMatchObject({
      output: expect.stringMatching(/^[ab]{1,2}c$/u),
    });
    // Another key, or another caller with the same key, gets its own sandbox.
    expect(await note("x", alice, "lobby")).toMatchObject({ output: "x" });
    expect(await note("y", bob, "desk")).toMatchObject({ output: "y" });
    expect(starts).toHaveLength(3);
    expect(deleted).not.toHaveBeenCalled();
  });

  it("keeps forwarded callers apart by effective user and by the forwarder that vouched", async () => {
    const { registry, starts } = keyedSandboxes();
    const runtime = runtimeWith([noteTool()], registry);
    const router = (principalId: string): SessionAuthContext => ({
      ...alice,
      principalId,
      principalType: "service",
    });
    const [routerA, routerB] = [router("router-a"), router("router-b")];
    // A forwarded user's attributes are asserted by the forwarder, so the
    // session must not depend on them: both routers stamp the same ones.
    const forwarded = (principalId: string): SessionAuthContext => ({
      ...alice,
      attributes: { "eve:forwarded-by": "router" },
      principalId,
    });
    const note = (text: string, auth: SessionAuthContext, forwardedBy: SessionAuthContext) =>
      invokeTool(runtime, "note", { text }, { auth, forwardedBy, key: "desk" });

    expect(await note("a", forwarded("alice"), routerA)).toMatchObject({ output: "a" });
    // Another user through the same router, with the same key.
    expect(await note("b", forwarded("bob"), routerA)).toMatchObject({ output: "b" });
    // The same user and key through another router.
    expect(await note("c", forwarded("alice"), routerB)).toMatchObject({ output: "c" });
    // Neither is the user's direct session, and the first one is still there.
    const direct = await invokeTool(runtime, "note", { text: "d" }, { auth: alice, key: "desk" });
    expect(direct).toMatchObject({ output: "d" });
    expect(await note("e", forwarded("alice"), routerA)).toMatchObject({ output: "ae" });
    expect(starts).toHaveLength(4);
    expect(new Set(starts).size).toBe(4);
  });

  it("leaves a keyed sandbox running and lets go of each call's handle when it ends", async () => {
    const { deleted, handles, kinds, registry, released, stopped } = keyedSandboxes();
    let openGate!: () => void;
    const held = runtimeWith(
      [noteTool(new Promise<void>((resolve) => (openGate = resolve)))],
      registry,
    );
    const failing = tool("failing", async (_input: unknown, ctx) => {
      await ctx.getSandbox();
      throw new Error("boom");
    });
    const runtime = runtimeWith([noteTool(), failing], registry);
    const call = (name: string, text: string, run = runtime) =>
      invokeTool(run, name, { text }, { auth: alice, key: "desk" });

    const holding = call("note", "a", held);
    await vi.waitFor(() => expect(handles).toHaveLength(1));
    // An overlapping call reopens the same sandbox through its own handle and
    // releases only that one when it ends; the first call's handle stays open.
    expect(await call("note", "b")).toMatchObject({ status: "completed" });
    expect(released).toEqual([handles[1]]);
    openGate();
    expect(await holding).toMatchObject({ status: "completed" });
    expect(released).toEqual([handles[1], handles[0]]);
    // A call that fails after opening its sandbox still lets go of its handle.
    expect(await call("failing", "")).toMatchObject({ status: "failed" });
    expect(handles).toHaveLength(3);
    expect(released).toEqual([handles[1], handles[0], handles[2]]);

    // No call's connection is left for server shutdown, and the sandbox itself stays.
    await shutdownActiveSandboxConnections();
    expect(stopped).not.toHaveBeenCalled();
    expect(new Set(kinds)).toEqual(new Set(["tool-session"]));
    expect(deleted).not.toHaveBeenCalled();
    expect(await call("note", "c")).toMatchObject({ output: expect.stringMatching(/^[ab]{2}c$/u) });
  });

  it("denies an anonymous caller a key before deriving a session or opening a sandbox", async () => {
    const { registry, starts } = keyedSandboxes();
    const execute = vi.fn(() => "ran");
    const runtime = runtimeWith([tool("note", execute)], registry);
    const anonymous: SessionAuthContext = {
      attributes: {},
      authenticator: "none",
      principalId: "anonymous",
      principalType: "anonymous",
    };

    expect(await invokeTool(runtime, "note", {}, { auth: anonymous, key: "desk" })).toEqual({
      reason: expect.stringContaining("anonymous caller cannot send a key"),
      status: "denied",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(starts).toHaveLength(0);
    // Without a key the anonymous caller still gets a one-off call.
    expect(await invokeTool(runtime, "note", {}, { auth: anonymous })).toMatchObject({
      output: "ran",
      status: "completed",
    });
  });

  it("refuses a keyed sandbox on a provider that cannot keep it, and an empty key", async () => {
    const { registry, started } = sandboxes();
    const runtime = runtimeWith([noteTool()], registry);
    expect(await invokeTool(runtime, "note", { text: "a" }, { auth: alice, key: "desk" })).toEqual({
      message: expect.stringContaining('Sandbox provider "memory" cannot keep a sandbox'),
      status: "failed",
    });
    expect(started).toHaveLength(0);
    expect(await invokeTool(runtime, "note", { text: "a" }, { auth: alice, key: "" })).toEqual({
      message: "The tool session key must not be empty.",
      status: "invalid-input",
    });
  });

  it("never deletes a keyed sandbox another call is using when its own start fails", async () => {
    let failSelector = false;
    const { deleted, live, registry } = keyedSandboxes({ failSelector: () => failSelector });
    let openGate!: () => void;
    const runtime = runtimeWith(
      [noteTool(new Promise<void>((resolve) => (openGate = resolve)))],
      registry,
    );
    const holding = invokeTool(runtime, "note", { text: "a" }, { auth: alice, key: "desk" });
    await vi.waitFor(() => expect(live.size).toBe(1));

    // The second call's `start` finds the first call's sandbox, then its selector fails.
    failSelector = true;
    expect(
      await invokeTool(runtime, "note", { text: "b" }, { auth: alice, key: "desk" }),
    ).toMatchObject({ status: "failed" });
    openGate();
    expect(await holding).toMatchObject({ output: "a", status: "completed" });
    expect(deleted).not.toHaveBeenCalled();
  });
});

const bob: SessionAuthContext = { ...alice, principalId: "bob" };
