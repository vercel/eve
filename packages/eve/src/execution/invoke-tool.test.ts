import { afterEach, describe, expect, it, vi } from "vitest";

import type { Approval, ApprovalPolicy } from "#approval/definition.js";
import type { SessionAuthContext } from "#channel/types.js";
import { shutdownActiveSandboxHandles } from "#execution/sandbox/active-handles.js";
import { invokeTool, type InvokeToolRuntime } from "#execution/invoke-tool.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
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
  it("evaluates the approval policy on every call and checks a passed answer", async () => {
    const ask: ApprovalPolicy = () => "user-approval";
    const onlyBob: Approval = {
      request: ask,
      response: ({ response }) =>
        response.principal.principalId === "bob"
          ? { status: "allowed" }
          : { reason: "Only Bob may approve.", status: "rejected" },
    };
    const yes = { approved: true };
    const policies: Array<[Approval, { approved: boolean } | undefined, object, boolean]> = [
      [ask, undefined, { callId: "call-1", status: "approval-required" }, false],
      [
        () => ({ reason: "Read-only mode.", type: "denied" }),
        yes,
        { reason: "Read-only mode.", status: "denied" },
        false,
      ],
      [() => "not-applicable", undefined, { output: "ran", status: "completed" }, true],
      [ask, yes, { output: "ran", status: "completed" }, true],
      [ask, { approved: false }, { status: "denied" }, false],
      [onlyBob, yes, { reason: "Only Bob may approve.", status: "denied" }, false],
    ];
    for (const [approval, answer, expected, ran] of policies) {
      const execute = vi.fn(() => "ran");
      const runtime = runtimeWith([tool("deploy", execute, { approval })]);
      const options = { approval: answer, auth: alice, callId: "call-1" };
      expect(await invokeTool(runtime, "deploy", {}, options)).toMatchObject(expected);
      expect(execute).toHaveBeenCalledTimes(ran ? 1 : 0);
    }
    const tooLong = { auth: alice, callId: "c".repeat(513) };
    expect(await invokeTool(runtimeWith([]), "deploy", {}, tooLong)).toMatchObject({
      status: "invalid-input",
    });
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
});
