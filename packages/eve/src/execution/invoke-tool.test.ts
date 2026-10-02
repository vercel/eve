import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApprovalPolicy } from "#approval/definition.js";
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

function sandboxes() {
  const started: string[] = [];
  const deleted = vi.fn(async () => {});
  const shutdown = vi.fn(async () => {});
  const start = vi.fn(async (context: { readonly session: { readonly id: string } }) => {
    started.push(context.session.id);
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
});
