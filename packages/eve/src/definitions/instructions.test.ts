import { describe, expect, it, vi } from "vitest";

import {
  announcedNext,
  beforeModelCall,
  evaluationError,
  definitionSession,
} from "#internal/testing/definition-session.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { evaluateStepValues, stepSystem } from "#definitions/step.js";
import { restoreDefinitions } from "#definitions/kernel.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SandboxKey, SessionIdKey, SessionKey } from "#context/keys.js";
import { fromCompiledBundle } from "#definitions/compiled-agent.js";
import { createFrameworkUserMessage } from "#harness/messages.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import { SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import { DefaultSandbox } from "#sandbox/providers/default.js";
import { HostSandbox } from "#sandbox/providers/host.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";

const system = async (ctx: ReturnType<typeof definitionSession>["ctx"]) => {
  const prompt = await stepSystem({
    config: { tools: new Map() },
    ctx,
    finalReplyOnly: false,
    session: {},
  });
  return typeof prompt === "string" ? [] : prompt.slice(1);
};

describe("dynamic instructions", () => {
  it("keeps system instructions in definition order, and drops one that returns null or blank text", async () => {
    let policy: string | null = "Follow the policy.";
    const { ctx } = definitionSession({
      instructions: [
        { evaluate: () => defineInstructions({ content: "Be brief." }), slug: "brief" },
        {
          evaluate: () => (policy === null ? null : defineInstructions({ content: policy })),
          slug: "policy",
        },
        { evaluate: () => defineInstructions({ content: "   " }), slug: "blank" },
      ],
    });
    await beforeModelCall(ctx);
    expect(await system(ctx)).toEqual(["Be brief.", "Follow the policy."]);

    policy = null;
    await beforeModelCall(ctx);
    expect(await system(ctx)).toEqual(["Be brief."]);
  });

  it("keeps user instructions out of the system prompt and adds no message for blank text", async () => {
    const { ctx } = definitionSession({
      instructions: [
        {
          evaluate: () => defineInstructions({ content: "Alice prefers tables.", role: "user" }),
          slug: "prefs",
        },
        { evaluate: () => defineInstructions({ content: "\n", role: "user" }), slug: "blank" },
      ],
    });
    expect(await announcedNext(ctx)).toEqual(["Alice prefers tables."]);
    expect(await system(ctx)).toEqual([]);
  });

  it("announces static user instructions once, as it does dynamic ones", async () => {
    const { ctx } = definitionSession({ userInstructions: ["  Pinned policy.  ", " \n "] });
    expect(await announcedNext(ctx)).toEqual(["Pinned policy."]);
    expect(await announcedNext(ctx)).toEqual([]);
  });

  it("doesn't announce a static user instruction a session from before holds in its history", async () => {
    const { ctx } = definitionSession({ userInstructions: ["Pinned policy."] });
    const conversation = [createFrameworkUserMessage("context.instruction", "Pinned policy.")];
    await contextStorage.run(ctx, () => restoreDefinitions(ctx, { conversation }));
    expect(await announcedNext(ctx)).toEqual([]);
  });

  it("rejects a value without defineInstructions()", async () => {
    const { ctx } = definitionSession({
      instructions: [{ evaluate: () => ({ content: "Be brief." }), slug: "brief" }],
    });
    expect(await evaluationError(ctx)).toContain("wrap with defineInstructions()");
  });
});

function workspaceContext(input: {
  readonly provider: "default" | "host";
  readonly rootEntries?: readonly string[];
  readonly sandboxCwd?: string;
}) {
  const ctx = new ContextContainer();
  const sessionId = `sess-${Math.random()}`;
  ctx.set(SessionIdKey, sessionId);
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId,
  } as never);
  const environment =
    input.provider === "host" ? HostSandbox.environment() : DefaultSandbox.environment();
  ctx.set(
    SessionAgentKey,
    fromCompiledBundle({
      graph: {
        nodesByNodeId: new Map(),
        root: {
          sandboxRegistry: { sandbox: { definition: { environment, kind: "independent" } } },
        },
      },
      resolvedAgent: {
        channels: [],
        definitions: [],
        instructions: [
          {
            content: "Help the user.",
            name: "agent",
            owner: { kind: "application" },
            role: "system",
          },
        ],
        sandbox: { environment, kind: "independent" },
        skills: [],
      },
      subagentRegistry: { dynamicResolvers: [], preparedTools: [], subagentsByName: new Map() },
      toolRegistry: { toolsByName: new Map() },
      turnAgent: {
        workspaceSpec: { rootEntries: input.rootEntries ?? [] },
      },
    } as never),
  );
  enterSessionProjection(ctx, undefined);
  const getSandbox = vi.fn(async () => ({
    resolvePath: () => input.sandboxCwd ?? "/testbed",
  }));
  ctx.set(SandboxKey, { get: getSandbox } as never);
  return { ctx, getSandbox };
}

function stubTools(...names: string[]): Map<string, HarnessToolDefinition> {
  return new Map(
    names.map((name) => [
      name,
      { description: name, inputSchema: {}, name } as HarnessToolDefinition,
    ]),
  );
}

describe("workspace working directory instruction", () => {
  it("adds Current working directory: /workspace when a sandbox tool exists on an isolated provider without opening the sandbox", async () => {
    const { ctx, getSandbox } = workspaceContext({ provider: "default" });
    const step = {
      config: { tools: stubTools("bash") },
      ctx,
      finalReplyOnly: false,
      session: {},
    };
    await evaluateStepValues(step, { conversation: [] });
    const prompt = await stepSystem(step);

    expect(prompt).toContain("Current working directory: /workspace");
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it("omits Current working directory when no sandbox tools are offered", async () => {
    const { ctx, getSandbox } = workspaceContext({ provider: "host" });
    const step = {
      config: { tools: stubTools("web_fetch") },
      ctx,
      finalReplyOnly: false,
      session: {},
    };
    await evaluateStepValues(step, { conversation: [] });
    const prompt = await stepSystem(step);

    expect(prompt).not.toContain("Current working directory:");
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it("resolves and caches HostSandbox cwd once per session and combines it with workspace entries", async () => {
    const { ctx, getSandbox } = workspaceContext({
      provider: "host",
      rootEntries: ["README.md"],
      sandboxCwd: "/testbed",
    });
    const step = {
      config: { tools: stubTools("read_file") },
      ctx,
      finalReplyOnly: false,
      session: {},
    };
    await evaluateStepValues(step, { conversation: [] });
    const first = await stepSystem(step);
    await evaluateStepValues(step, { conversation: [] });
    const second = await stepSystem(step);

    expect(first).toContain("Current working directory: /testbed");
    expect(first).toContain("Workspace\n- You have access to authored files");
    expect(second).toBe(first);
    expect(getSandbox).toHaveBeenCalledTimes(1);
  });
});
