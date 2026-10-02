import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApprovalPolicy } from "#approval/definition.js";
import type { SessionAuthContext } from "#channel/types.js";
import { shutdownActiveSandboxHandles } from "#execution/sandbox/active-handles.js";
import { invokeTool, type InvokeToolRuntime } from "#execution/invoke-tool.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import {
  sweepToolSessionSandboxes,
  withToolSessionSandboxes,
} from "#execution/tool-session/sandbox.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";
import type { ToolContext } from "#tools/definition.js";
import { defineJsonSchema } from "#tools/schema.js";

vi.mock("#runtime/sandbox/prepared-artifacts.js", () => ({
  loadSandboxPreparedArtifact: vi.fn(async () => null),
}));

afterEach(() => shutdownActiveSandboxHandles());

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

function sandboxes(options: { readonly startGate?: Promise<void> } = {}) {
  const started: string[] = [];
  const deleted = vi.fn(async () => {});
  const shutdown = vi.fn(async () => {});
  const start = vi.fn(async (context: { readonly session: { readonly id: string } }) => {
    started.push(context.session.id);
    await options.startGate;
    const sandbox = mockSandbox();
    return {
      handle: {
        sandbox: sandbox.session,
        onRuntimeShutdown: shutdown,
        onSessionDelete: deleted,
        onSessionStop: async () => {},
      },
      state: null,
    };
  });
  const environment = defineSandboxProvider({
    name: "memory",
    environment: () => ({
      prepare: async () => null,
      resume: async () => {
        throw new Error("a call's sandbox is never resumed");
      },
      start,
    }),
  }).environment();
  const registry: RuntimeSandboxRegistry = {
    sandbox: {
      definition: {
        environment,
        kind: "independent",
        logicalPath: "sandbox.ts",
        revisionHash: "hash",
        selector: defineSandbox(async () => await environment.open()),
        sourceId: "sandbox",
        sourceKind: "module",
      },
      workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
    },
  };
  return { deleted, registry, shutdown, started };
}

/**
 * A provider whose `start` reopens a session's sandbox by session id, as
 * Vercel Sandbox and just-bash do, opted into tool sessions with a sweeper.
 */
function keyedSandboxes(options: { readonly failSelector?: () => boolean } = {}) {
  const live = new Map<
    string,
    { lastUsedAt: number; running: boolean; sandbox: ReturnType<typeof mockSandbox> }
  >();
  const starts: string[] = [];
  const deleted = vi.fn((sessionId: string) => void live.delete(sessionId));
  const reopen = (sessionId: string) => {
    let entry = live.get(sessionId);
    if (entry === undefined) {
      starts.push(sessionId);
      entry = { lastUsedAt: Date.now(), running: false, sandbox: mockSandbox() };
      live.set(sessionId, entry);
    }
    return {
      sandbox: entry.sandbox.session,
      onRuntimeShutdown: async () => {},
      onSessionDelete: async () => deleted(sessionId),
      onSessionStop: async () => {},
    };
  };
  const summary = (sessionId: string) => ({ ...live.get(sessionId)!, name: sessionId, sessionId });
  const environment = defineSandboxProvider({
    name: "keyed",
    environment: () =>
      withToolSessionSandboxes(
        {
          prepare: async () => null,
          resume: async (context: { readonly session: { readonly id: string } }) =>
            reopen(context.session.id),
          start: async (context: { readonly session: { readonly id: string } }) => ({
            handle: reopen(context.session.id),
            state: {},
          }),
        },
        {
          list: async () => [...live.keys()].map(summary),
          deleteUnless: async (name, keep) => {
            if (!live.has(name) || keep(summary(name))) return false;
            deleted(name);
            return true;
          },
        },
      ),
  }).environment();
  const registry: RuntimeSandboxRegistry = {
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
  return { deleted, live, registry, starts };
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
    const runtime = runtimeWith([tool("note", execute), tool("load_skill", execute)], undefined, {
      load_skill: "framework",
    });
    expect(await invokeTool(runtime, "missing", {}, { auth: alice })).toMatchObject({
      message: 'The agent has no tool named "missing".',
      status: "failed",
    });
    expect(await invokeTool(runtime, "load_skill", {}, { auth: alice })).toMatchObject({
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
    await shutdownActiveSandboxHandles();
    expect(shutdown).not.toHaveBeenCalled();
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
    await shutdownActiveSandboxHandles();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("allocates no sandbox for a failed call that never asked for one", async () => {
    const { deleted, registry, started } = sandboxes();
    const failing = tool("failing", () => {
      throw new Error("boom");
    });
    expect(
      await invokeTool(runtimeWith([failing], registry), "failing", {}, { auth: alice }),
    ).toMatchObject({ status: "failed" });
    expect(started).toHaveLength(0);
    expect(deleted).not.toHaveBeenCalled();
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
    const runtime = runtimeWith([noteTool()], sandboxes().registry);
    expect(await invokeTool(runtime, "note", { text: "a" }, { auth: alice, key: "desk" })).toEqual({
      message: expect.stringContaining('Sandbox provider "memory" cannot keep a sandbox'),
      status: "failed",
    });
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

  it("sweeps only idle tool-session sandboxes no call holds", async () => {
    const { live, registry } = keyedSandboxes();
    let openGate!: () => void;
    const held = runtimeWith(
      [noteTool(new Promise<void>((resolve) => (openGate = resolve)))],
      registry,
    );
    const idle = runtimeWith([noteTool()], registry);
    await invokeTool(idle, "note", { text: "a" }, { auth: alice, key: "idle" });
    await invokeTool(idle, "note", { text: "a" }, { auth: alice, key: "recent" });
    await invokeTool(idle, "note", { text: "a" }, { auth: alice, key: "running" });
    const holding = invokeTool(held, "note", { text: "a" }, { auth: alice, key: "leased" });
    await vi.waitFor(() => expect(live.size).toBe(4));

    const now = Date.now();
    const [idleId, recentId, runningId, leasedId] = [...live.keys()];
    for (const id of [idleId, runningId, leasedId]) live.get(id!)!.lastUsedAt = now - 31 * DAY_MS;
    live.get(runningId!)!.running = true;
    live.get(recentId!)!.lastUsedAt = now - DAY_MS;

    const swept = await sweepToolSessionSandboxes({ now, registry });
    expect(swept).toEqual({ deleted: [idleId], failed: [] });
    openGate();
    await holding;
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

const bob: SessionAuthContext = { ...alice, principalId: "bob" };
