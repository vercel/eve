import { asSchema, jsonSchema } from "ai";
import * as serialization from "#context/serialize.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { dispatchDynamicToolEvent } from "#context/dynamic-tool-lifecycle.js";
import { createStepStartedEvent } from "#protocol/message.js";
import { resolveConnectionSearchDynamicTools } from "#execution/tools/connection-search.js";
import { never, always, once } from "#tools/approval/policies.js";
import { writeApprovedToolKeys } from "#harness/hitl/approved-tools.js";
import type { ApprovalContext } from "#approval/definition.js";
import type { ResolvedDynamicToolResolver } from "#runtime/types.js";
import {
  AuthKey,
  SessionIdKey,
  SessionDynamicToolMetadataKey,
  StepDynamicToolMetadataKey,
  TurnDynamicToolMetadataKey,
} from "#context/keys.js";
import type { CurrentDynamicToolMetadata } from "#context/dynamic-tool-metadata.js";
import { buildResponseAuthorizationTools } from "#context/build-dynamic-tools.js";
import {
  AuthorizationHookKey,
  CallbackBaseUrlKey,
  consumeAuthorizationResult,
  getAuthorizationResults,
  getHookUrl,
  isAuthorizationSignal,
  PendingAuthorizationResultKey,
  requestAuthorization,
} from "#harness/authorization.js";
import type { CodeModeToolOutcome } from "#execution/code-mode/program-step.js";
import { buildToolSet } from "#harness/tools.js";
import { applyCodeModeTool, claimsForCodeMode } from "#harness/code-mode.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  registerDurableDynamicCallback,
  stampDurableDynamicToolCallbacks,
  clearDurableDynamicCallbacks,
} from "#tools/durable-callbacks.js";
import * as sandbox from "#shared/workflow-sandbox.js";
import { defineTool } from "#tools/definition.js";

const state = vi.hoisted(() => ({
  ctx: undefined as ContextContainer | undefined,
  sessionState: {} as Record<string, unknown>,
  tools: new Map<string, HarnessToolDefinition>(),
}));
vi.mock("#context/serialize.js", async (importOriginal) => ({
  ...(await importOriginal()),
  deserializeContext: async () => state.ctx,
  serializeContext: (ctx: ContextContainer) =>
    Object.fromEntries(
      [...ctx.entries()]
        .filter(([key]) => key.name !== "test.bundle" && key.name !== "eve.connectionRegistry")
        .map(([key, value]) => [key.name, value]),
    ),
}));
vi.mock("#runtime/sessions/runtime-context-keys.js", async () => {
  const { ContextKey } = await import("#context/key.js");
  return { BundleKey: new ContextKey("test.bundle"), ChannelKey: new ContextKey("test.channel") };
});
vi.mock("#context/providers/connection.js", async () => {
  const { ContextKey } = await import("#context/key.js");
  return {
    connectionProvider: { key: new ContextKey("test.connection"), create: () => undefined },
  };
});
vi.mock("#context/providers/sandbox.js", async () => {
  const { ContextKey } = await import("#context/key.js");
  return { sandboxProvider: { key: new ContextKey("test.sandbox"), create: () => undefined } };
});
vi.mock("#execution/node-step.js", () => ({
  createNodeHarnessTools: () => state.tools,
  buildRuntimeIdentity: () => ({ agentId: "test", eveVersion: "test" }),
}));
vi.mock("#execution/durable-session-store.js", () => ({
  readDurableSession: async () => ({
    state: {
      "eve.harness.workflowContinuationSecurity": { version: 1, signingKey: "a".repeat(43) },
    },
  }),
}));
vi.mock("#execution/effective-agent-config.js", () => ({
  resolveEffectiveAgentRuntime: () => ({ turnAgent: {} }),
}));
vi.mock("#execution/session.js", () => ({
  hydrateDurableSession: () => ({
    agent: { modelReference: { id: "test" } },
    history: [],
    state: {
      "eve.harness.workflowContinuationSecurity": { version: 1, signingKey: "a".repeat(43) },
      ...state.sessionState,
    },
  }),
}));
vi.mock("#runtime/graph.js", () => ({ getResolvedRuntimeAgentNode: () => ({}) }));
vi.mock("#context/dynamic-subagent-lifecycle.js", () => ({ buildDynamicSubagentTools: () => [] }));

const { BundleKey } = await import("#runtime/sessions/runtime-context-keys.js");
const { executeCodeModeToolStep, runCodeModeProgramStep } =
  await import("#execution/code-mode/program-step.js");

function definition(
  name: string,
  extra: Partial<HarnessToolDefinition> = {},
): HarnessToolDefinition {
  return {
    name,
    description: name,
    inputSchema: jsonSchema({ type: "object" }),
    execute: async () => "ok",
    ...extra,
  };
}

type StepInput = Parameters<typeof executeCodeModeToolStep>[1];
type AuthorizationResults = NonNullable<ReturnType<typeof getAuthorizationResults>>;

const runCtx = {
  abortSignal: new AbortController().signal,
  callId: "outer",
  toolName: "code_mode",
};

/**
 * Mirrors what `withWorkflowStepAuthorization` seeds on the ambient context
 * before the twin invokes this step, and exposes it for assertions.
 */
function runStep(input: StepInput, authorizationResults: AuthorizationResults = []) {
  const ambient = new ContextContainer();
  ambient.setVirtualContext(AuthorizationHookKey, "nested-auth");
  ambient.setVirtualContext(PendingAuthorizationResultKey, authorizationResults);
  return {
    ambient,
    result: contextStorage.run(ambient, () => executeCodeModeToolStep(runCtx, input)),
  };
}

function nestedInput(name: string, overrides: Partial<StepInput> = {}): StepInput {
  return {
    event: { sequence: 1, stepIndex: 2, turnId: "turn" },
    serializedContext: {},
    sessionState: {} as never,
    toolCallId: "inner",
    toolName: name,
    toolInput: {},
    ...overrides,
  };
}

function nested(name: string, authorizationResults?: AuthorizationResults) {
  return runStep(nestedInput(name), authorizationResults).result;
}

type SettledToolOutcome = Exclude<CodeModeToolOutcome, { status: "approval-required" }>;

/**
 * Settles a nested call the way the body sees it once approval is behind it:
 * a signal or an approval request here is a test failure.
 */
async function settled(input: StepInput): Promise<SettledToolOutcome> {
  const outcome = await runStep(input).result;
  if (isAuthorizationSignal(outcome)) throw new Error("unexpected authorization signal");
  if (outcome.status === "approval-required") throw new Error("unexpected approval request");
  return outcome;
}

function registerLookupCallbacks(): void {
  for (const scope of ["session", "turn", "step"] as const) {
    registerDurableDynamicCallback({
      callback: (closure) => closure.value,
      phase: "execute",
      owner: {
        sessionId: "parent-session",
        scope,
        resolverSlug: "lookup",
        entryKey: "lookup",
        name: "lookup",
      },
    });
  }
}

function dynamic(value: string): CurrentDynamicToolMetadata {
  return {
    name: "lookup",
    description: "lookup",
    inputSchema: { type: "object" },
    resolverSlug: "lookup",
    entryKey: "lookup",
    callbacks: { execute: { closure: { value } } },
  };
}

beforeEach(() => {
  state.ctx = new ContextContainer();
  state.ctx.set(AuthKey, null);
  state.ctx.set(SessionIdKey, "parent-session");
  state.ctx.set(CallbackBaseUrlKey, "https://app.example");
  state.ctx.set(BundleKey, { graph: {}, nodeId: "root", resolvedAgent: {} } as never);
  state.sessionState = {};
  state.tools = new Map();
});

describe("executeCodeModeToolStep", () => {
  describe("approval gate", () => {
    const approvalRequest = {
      allowFreeform: false,
      display: "confirmation",
      options: [
        { id: "approve", label: "Approve" },
        { id: "cancel", label: "Cancel" },
      ],
      prompt: "Approve tool call: gated",
    };
    const denied = (detail = "") =>
      `CODE_MODE_APPROVAL_DENIED: the approval policy declined to run "gated".${detail}`;

    it("asks for an always() tool with the direct path's prompt and the nested call as the action, running nothing", async () => {
      const execute = vi.fn(async () => "ran");
      state.tools.set("gated", definition("gated", { approval: always(), execute }));
      await expect(
        runStep(nestedInput("gated", { toolInput: { region: "eu" } })).result,
      ).resolves.toEqual({
        status: "approval-required",
        approvalKey: "gated",
        action: { callId: "inner", input: { region: "eu" }, toolName: "gated" },
        request: approvalRequest,
      });
      expect(execute).not.toHaveBeenCalled();
    });

    it("keys once() on the recorded approval and runs without asking afterwards", async () => {
      const execute = vi.fn(async () => "ran");
      state.tools.set("gated", definition("gated", { approval: once(), execute }));
      await expect(nested("gated")).resolves.toMatchObject({
        status: "approval-required",
        approvalKey: "gated",
      });
      expect(execute).not.toHaveBeenCalled();
      state.sessionState = { ...writeApprovedToolKeys({}, ["gated"]) };
      await expect(nested("gated")).resolves.toEqual({ status: "completed", output: "ran" });
      expect(execute).toHaveBeenCalledOnce();
    });

    it("uses the definition's approvalKey for recording and remembered approvals", async () => {
      state.tools.set(
        "gated",
        definition("gated", {
          approval: ({ approvedTools, toolName, toolInput }) =>
            approvedTools.has(`${toolName}:${String(toolInput?.region)}`)
              ? "not-applicable"
              : "user-approval",
          approvalKey: (toolInput) => `gated:${String(toolInput.region)}`,
        }),
      );
      // Fine-grained policies key on input: a different region still prompts.
      state.sessionState = { ...writeApprovedToolKeys({}, ["gated:us"]) };
      await expect(
        runStep(nestedInput("gated", { toolInput: { region: "eu" } })).result,
      ).resolves.toMatchObject({ status: "approval-required", approvalKey: "gated:eu" });
      await expect(
        runStep(nestedInput("gated", { toolInput: { region: "us" } })).result,
      ).resolves.toEqual({ status: "completed", output: "ok" });
    });

    it("skips the policy and runs the tool when the call carries an approval", async () => {
      const approval = vi.fn((_context: ApprovalContext) => "user-approval" as const);
      const execute = vi.fn(async () => "ran");
      state.tools.set("gated", definition("gated", { approval, execute }));
      await expect(
        runStep(nestedInput("gated", { approval: { key: "gated" } })).result,
      ).resolves.toEqual({ status: "completed", output: "ran" });
      expect(approval).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledOnce();
    });

    it("gates an authored workflow tool before clearing it for its inline body", async () => {
      state.tools.set(
        "gated_wf",
        definition("gated_wf", { approval: always(), workflowId: "workflow//app//gated_wf" }),
      );
      await expect(nested("gated_wf")).resolves.toMatchObject({
        status: "approval-required",
        approvalKey: "gated_wf",
      });
      await expect(
        runStep(nestedInput("gated_wf", { approval: { key: "gated_wf" } })).result,
      ).resolves.toEqual({ status: "cleared" });
    });

    it.each([
      ["unset", {}, { status: "completed", output: "ok" }],
      ["never()", { approval: never() }, { status: "completed", output: "ok" }],
      ["approved", { approval: () => "approved" as const }, { status: "completed", output: "ok" }],
      ["true", { approval: () => true }, { status: "approval-required" }],
      ["false", { approval: () => false }, { status: "completed", output: "ok" }],
      ["denied", { approval: () => "denied" as const }, { status: "failed", error: denied() }],
      [
        "denied with reason",
        { approval: () => ({ type: "denied" as const, reason: "outside business hours" }) },
        { status: "failed", error: denied(" outside business hours") },
      ],
    ] as const)("maps a %s policy answer", async (_label, extra, expected) => {
      state.tools.set("gated", definition("gated", extra as Partial<HarnessToolDefinition>));
      await expect(nested("gated")).resolves.toMatchObject(expected);
    });

    it("evaluates the policy with the turn's session context", async () => {
      const approval = vi.fn((_context: ApprovalContext) => "user-approval" as const);
      state.tools.set("gated", definition("gated", { approval }));
      await nested("gated");
      expect(approval).toHaveBeenCalledOnce();
      expect(approval.mock.calls[0]?.[0]).toMatchObject({
        callId: "inner",
        session: { id: "parent-session" },
        toolName: "gated",
      });
    });

    it("fails for tools the program cannot call and when the policy throws", async () => {
      state.tools.set(
        "background",
        definition("background", { approval: always(), execution: "background" }),
      );
      await expect(nested("background")).resolves.toEqual({
        status: "failed",
        error: 'Tool "background" is not available to code_mode in this session.',
      });
      const execute = vi.fn(async () => "ran");
      state.tools.set(
        "gated",
        definition("gated", {
          approval: () => {
            throw new Error("policy exploded");
          },
          execute,
        }),
      );
      await expect(nested("gated")).resolves.toEqual({
        status: "failed",
        error: "policy exploded",
      });
      expect(execute).not.toHaveBeenCalled();
    });
  });

  // A gated connection tool asks first like any other; once the body hands
  // back the approval it executes here like an ungated one.
  it.each([
    { policy: "unset", approval: undefined },
    { policy: "never", approval: never() },
    { policy: "always", approval: always() },
  ])(
    "restores and executes a discovered connection with $policy approval after a cold start",
    async ({ policy, approval }) => {
      const executeTool = vi.fn(async () => ({ issues: ["issue-1"] }));
      const resolver: ResolvedDynamicToolResolver = {
        slug: "connection_search",
        logicalPath: "tools/connection_search.ts",
        sourceId: "tools/connection_search",
        sourceKind: "module",
        eventNames: ["step.started"],
        events: { "step.started": resolveConnectionSearchDynamicTools },
      };
      state.ctx!.set(BundleKey, {
        graph: {},
        nodeId: "root",
        resolvedAgent: { dynamicToolResolvers: [resolver] },
      } as never);
      state.ctx!.set(ConnectionRegistryKey, {
        dispose: async () => {},
        getConnectionApproval: () => approval,
        getConnectionNames: () => ["tracker"],
        getConnections: () => [
          {
            connectionName: "tracker",
            description: "Issues",
            protocol: "mcp",
            logicalPath: "connections/tracker.ts",
            sourceId: "connections/tracker",
            sourceKind: "module",
            url: "https://tracker.example/mcp",
          },
        ],
        getClient: () => ({
          close: async () => {},
          connect: async () => {},
          getTools: async () => ({}),
          executeTool,
          getToolMetadata: async () => [
            { name: "list_issues", description: "List issues", inputSchema: { type: "object" } },
          ],
        }),
      });
      await contextStorage.run(state.ctx!, async () => {
        const initial = await resolveConnectionSearchDynamicTools();
        await (initial!.connection_search as ReturnType<typeof defineTool>).execute(
          { keywords: "issues" },
          {} as never,
        );
        await dispatchDynamicToolEvent({
          ctx: state.ctx!,
          resolvers: [resolver],
          messages: [],
          event: createStepStartedEvent({
            modelId: "test",
            sequence: 1,
            stepIndex: 2,
            turnId: "turn",
          }),
        });
      });
      clearDurableDynamicCallbacks("parent-session");

      const gated = policy === "always";
      if (gated) {
        await expect(nested("tracker__list_issues")).resolves.toMatchObject({
          status: "approval-required",
          approvalKey: "tracker__list_issues",
        });
        expect(executeTool).not.toHaveBeenCalled();
      }
      await expect(
        runStep(
          nestedInput(
            "tracker__list_issues",
            gated ? { approval: { key: "tracker__list_issues" } } : {},
          ),
        ).result,
      ).resolves.toEqual({
        status: "completed",
        output: { issues: ["issue-1"] },
      });
      expect(executeTool).toHaveBeenCalledExactlyOnceWith(
        "list_issues",
        {},
        expect.objectContaining({ callId: "inner" }),
      );
      await expect(nested("connection_search")).resolves.toMatchObject({ status: "failed" });
    },
  );

  it("restores a missing callback with the dispatched step coordinates and closure", async () => {
    const tool = defineTool({
      description: "cold",
      inputSchema: { type: "object" },
      execute: () => "unused",
    });
    stampDurableDynamicToolCallbacks(tool, {
      execute: { callback: (closure) => closure.value, closure: { value: "new resolver value" } },
    });
    const resolver = vi.fn((_event: unknown) => ({ cold: tool }));
    state.ctx!.set(BundleKey, {
      graph: {},
      nodeId: "root",
      resolvedAgent: {
        dynamicToolResolvers: [
          { slug: "cold", eventNames: ["step.started"], events: { "step.started": resolver } },
        ],
      },
    } as never);
    state.ctx!.set(StepDynamicToolMetadataKey, [
      { ...dynamic("dispatched"), name: "cold", resolverSlug: "cold", entryKey: "cold" },
    ]);
    await expect(nested("cold")).resolves.toEqual({ status: "completed", output: "dispatched" });
    expect(resolver).toHaveBeenCalledOnce();
    expect(resolver.mock.calls[0]?.[0]).toMatchObject({
      data: { sequence: 1, stepIndex: 2, turnId: "turn" },
    });
  });

  it("keeps ordinary background tools direct and rejects attempts to run them", async () => {
    const execute = vi.fn(async () => "done");
    state.tools.set("background", definition("background", { execution: "background", execute }));
    expect(claimsForCodeMode("background", state.tools)).toBe(false);
    await expect(nested("background")).resolves.toEqual({
      status: "failed",
      error: 'Tool "background" is not available to code_mode in this session.',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("clears an authored workflow tool for its inline body instead of running it as a step", async () => {
    const execute = vi.fn(async () => "done");
    state.tools.set(
      "plan_deploy",
      definition("plan_deploy", { execute, workflowId: "workflow//app//plan_deploy" }),
    );
    expect(claimsForCodeMode("plan_deploy", state.tools)).toBe(true);
    await expect(nested("plan_deploy")).resolves.toEqual({ status: "cleared" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns the full authorization challenge and resumes with its matched callback", async () => {
    const challenge = {
      attemptId: "attempt",
      name: "service",
      challenge: { url: "https://idp.example/auth" },
      hookUrl: "https://app.example/cb",
      principal: { id: "user", type: "user" as const },
      resume: { verifier: "test" },
    };
    state.tools.set(
      "authorize",
      definition("authorize", {
        execute: async () => {
          expect(getHookUrl("service", "attempt")).toContain("nested-auth");
          // Connection tools consume their result through scoped authorization.
          const result = consumeAuthorizationResult("service");
          return result === undefined
            ? requestAuthorization([challenge])
            : { resume: result.resume, callback: result.callback, principal: result.principal };
        },
      }),
    );
    const first = await nested("authorize");
    expect(isAuthorizationSignal(first)).toBe(true);
    expect(first).toMatchObject({ challenges: [challenge] });
    const callback = { method: "GET", params: { code: "accepted" } };
    const retry = runStep(nestedInput("authorize"), [
      {
        name: "service",
        attemptId: "attempt",
        hookUrl: challenge.hookUrl,
        callback,
        principal: challenge.principal,
        resume: challenge.resume,
      },
    ]);
    await expect(retry.result).resolves.toEqual({
      status: "completed",
      output: { resume: challenge.resume, callback, principal: challenge.principal },
    });
    // The twin learns which attempts completed from the ambient remainder.
    expect(retry.ambient.get(PendingAuthorizationResultKey)).toEqual([]);
  });

  it("uses the advertised step override ahead of turn, session, and authored definitions", async () => {
    state.tools.set("lookup", definition("lookup", { execute: async () => "authored" }));
    registerLookupCallbacks();
    state.ctx!.set(StepDynamicToolMetadataKey, [dynamic("step")]);
    state.ctx!.set(TurnDynamicToolMetadataKey, [dynamic("turn")]);
    state.ctx!.set(SessionDynamicToolMetadataKey, [dynamic("session")]);
    const effective = buildResponseAuthorizationTools({
      authoredTools: state.tools,
      context: state.ctx,
    });
    const tools = buildToolSet({ tools: effective });
    state.tools.set(
      "code_mode",
      definition("code_mode", {
        execute: undefined,
        workflowId: "workflow//eve//codeModeWorkflow",
      }),
    );
    const applied = await applyCodeModeTool({
      continuationSecurity: { signingKey: "test" },
      harnessTools: new Map([...effective, ["code_mode", state.tools.get("code_mode")!]]),

      maxSubagents: 100,

      tools: {
        ...tools,
        ...buildToolSet({ tools: new Map([["code_mode", state.tools.get("code_mode")!]]) }),
      },
    });
    expect(applied.modelTools).not.toHaveProperty("lookup");
    await expect(nested("lookup")).resolves.toEqual({ status: "completed", output: "step" });
  });

  it("claims a dynamic tool even when no authored tool has its name", async () => {
    state.tools.set(
      "code_mode",
      definition("code_mode", {
        execute: undefined,
        workflowId: "workflow//eve//codeModeWorkflow",
      }),
    );
    registerLookupCallbacks();
    state.ctx!.set(StepDynamicToolMetadataKey, [dynamic("discovered")]);
    const harnessTools = buildResponseAuthorizationTools({
      authoredTools: state.tools,
      context: state.ctx,
    });
    const result = await applyCodeModeTool({
      continuationSecurity: { signingKey: "test" },
      harnessTools,

      maxSubagents: 100,

      tools: buildToolSet({ tools: harnessTools }),
    });
    expect(Object.keys(result.modelTools)).toEqual(["code_mode"]);
    await expect(nested("lookup")).resolves.toEqual({ status: "completed", output: "discovered" });
  });
});

describe("runCodeModeProgramStep", () => {
  const input = {
    callId: "program",
    sessionState: {} as never,
    program: {
      js: "return 1;",

      toolCatalog: [],
      maxSubagents: 100,
    },
  };

  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])(
    "uses pinned stubs without restoring tool context (resume=%s)",
    async (resume) => {
      const restore = vi
        .spyOn(serialization, "deserializeContext")
        .mockRejectedValue(new Error("Tool context must not be restored"));
      const run = vi.fn().mockResolvedValue({ status: "completed", output: "done" });
      const resumed = vi.fn().mockResolvedValue({ status: "completed", output: "done" });
      const created = vi
        .spyOn(sandbox, "createWorkflowSandbox")
        .mockResolvedValue({ description: "", run, resume: resumed });
      const parking = vi.spyOn(sandbox, "createParkingHostTool");
      const toolCatalog = [
        {
          name: "lookup",
          description: "Pinned lookup",
          inputSchema: { type: "object" },
          outputSchema: { type: "string" },
          target: "tool" as const,
        },
        {
          name: "researcher",
          description: "Pinned agent",
          inputSchema: { type: "object" },
          outputSchema: null,
          target: "agent" as const,
        },
        {
          name: "gated",
          description: "Direct only",
          inputSchema: { type: "object" },
          outputSchema: null,
          target: "direct" as const,
        },
        {
          name: "plan_deploy",
          description: "Pinned workflow tool",
          inputSchema: { type: "object" },
          outputSchema: null,
          target: "workflow" as const,
          workflowId: "workflow//app//plan_deploy",
        },
      ];
      await expect(
        runCodeModeProgramStep({
          ...input,
          program: { ...input.program, toolCatalog },
          ...(resume
            ? {
                resume: {
                  interrupt: {} as never,
                  resolutions: [{ status: "completed" as const, output: null }],
                },
              }
            : {}),
        }),
      ).resolves.toEqual({ status: "completed", output: "done" });
      expect(restore).not.toHaveBeenCalled();
      expect(resume ? resumed : run).toHaveBeenCalledOnce();
      expect(resume ? run : resumed).not.toHaveBeenCalled();
      if (resume) {
        expect(resumed).toHaveBeenCalledWith({
          interrupt: {},
          resolutions: [{ status: "completed", output: null }],
        });
      } else {
        expect(run).toHaveBeenCalledWith({ js: "return 1;", toolCallId: "program" });
      }
      const tools = created.mock.calls[0]![0].hostTools;
      expect(Object.keys(tools).sort()).toEqual([
        "describe_tools",
        "lookup",
        "plan_deploy",
        "researcher",
        "search_tools",
      ]);
      expect(tools.lookup!.description).toBe("Pinned lookup");
      expect(asSchema(tools.lookup!.inputSchema).jsonSchema).toEqual({ type: "object" });
      expect(asSchema(tools.lookup!.outputSchema!).jsonSchema).toEqual({ type: "string" });
      expect(parking.mock.calls.map(([call]) => call.description)).toEqual([
        "Pinned lookup",
        expect.any(String),
        expect.any(String),
      ]);
    },
  );

  it("hands the parked interrupts back in the sandbox's order", async () => {
    const interrupt = { toolCallId: "t-call", toolName: "t", input: { q: 1 } } as never;
    vi.spyOn(sandbox, "createWorkflowSandbox").mockResolvedValue(
      sandboxWith({ status: "interrupted", interrupt, pending: [interrupt] }),
    );

    await expect(runCodeModeProgramStep(input)).resolves.toEqual({
      status: "interrupted",
      interrupt,
      pending: [interrupt],
    });
  });

  it("rejects an interrupted program with no pending call", async () => {
    const interrupt = {} as never;
    vi.spyOn(sandbox, "createWorkflowSandbox").mockResolvedValue(
      sandboxWith({ status: "interrupted", interrupt, pending: [] }),
    );

    await expect(runCodeModeProgramStep(input)).rejects.toThrow("contains no pending call");
  });

  it.each([false, true])("passes a program failure through (resume=%s)", async (resume) => {
    const failed = { status: "failed" as const, error: "invalid program" };
    const instance = sandboxWith(failed);
    vi.spyOn(sandbox, "createWorkflowSandbox").mockResolvedValue(instance);
    await expect(
      runCodeModeProgramStep({
        ...input,
        ...(resume
          ? {
              resume: {
                interrupt: {} as never,
                resolutions: [{ status: "completed" as const, output: null }],
              },
            }
          : {}),
      }),
    ).resolves.toEqual(failed);
    expect(resume ? instance.resume : instance.run).toHaveBeenCalledOnce();
  });

  it("rethrows a worker failure so workflow can retry it", async () => {
    const failure = Object.assign(new Error("worker failed"), { code: "RUN_ERROR" });
    vi.spyOn(sandbox, "createWorkflowSandbox").mockRejectedValue(failure);
    await expect(runCodeModeProgramStep(input)).rejects.toBe(failure);
  });
});

function sandboxWith(outcome: sandbox.WorkflowSandboxOutcome) {
  return {
    description: "",
    run: vi.fn().mockResolvedValue(outcome),
    resume: vi.fn().mockResolvedValue(outcome),
  };
}

describe("nested tool state across fresh contexts", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["todo", "file"])("preserves %s state across step boundaries", async (kind) => {
    const { resolveKey } = await import("#context/key.js");
    const { adoptCodeModeStateChanges } = await import("#execution/code-mode/state.js");
    const bundle = state.ctx!.require(BundleKey);
    vi.spyOn(serialization, "deserializeContext").mockImplementation(async (data) => {
      const ctx = new ContextContainer();
      ctx.set(BundleKey, bundle);
      for (const [name, value] of Object.entries(data)) {
        const key = resolveKey(name);
        if (key !== undefined) ctx.set(key, structuredClone(value));
      }
      return ctx;
    });
    let current = {
      serializedContext: serialization.serializeContext(state.ctx!),
      sessionState: {} as never,
    };
    async function invoke(name: string) {
      const outcome = await settled(nestedInput(name, { ...current, toolCallId: name }));
      current = adoptCodeModeStateChanges(current, outcome.stateChanges ?? []) as typeof current;
      return outcome;
    }
    if (kind === "todo") {
      const { executeTodoTool } = await import("#execution/tools/todo.js");
      const todos = [{ content: "review", priority: "high" as const, status: "pending" as const }];
      state.tools.set(
        "write",
        definition("write", { execute: async () => executeTodoTool({ todos }) }),
      );
      state.tools.set("read", definition("read", { execute: async () => executeTodoTool({}) }));
      expect(await invoke("write")).toMatchObject({ status: "completed", output: { todos } });
      expect(await invoke("read")).toMatchObject({ status: "completed", output: { todos } });
    } else {
      const { executeReadFileOnSandbox } = await import("#execution/sandbox/read-file.js");
      const { executeWriteFileOnSandbox } = await import("#execution/sandbox/write-file.js");
      const fs = { readTextFile: async () => "original", writeTextFile: vi.fn() };
      state.tools.set(
        "read_file",
        definition("read_file", {
          execute: async () =>
            executeReadFileOnSandbox(fs as never, { filePath: "/workspace/probe.txt" }),
        }),
      );
      state.tools.set(
        "write_file",
        definition("write_file", {
          execute: async () =>
            executeWriteFileOnSandbox(fs as never, {
              filePath: "/workspace/probe.txt",
              content: "updated",
            }),
        }),
      );
      expect(await invoke("read_file")).toMatchObject({ status: "completed" });
      expect(await invoke("write_file")).toMatchObject({
        status: "completed",
        output: { existed: true },
      });
      expect(fs.writeTextFile).toHaveBeenCalledOnce();
    }
    expect(current.serializedContext).not.toHaveProperty(AuthorizationHookKey.name);
  });

  it("merges parallel calls from one snapshot in pending order without conflicts", async () => {
    const { resolveKey } = await import("#context/key.js");
    const { adoptCodeModeStateChanges } = await import("#execution/code-mode/state.js");
    const { executeTodoTool } = await import("#execution/tools/todo.js");
    const { executeReadFileOnSandbox } = await import("#execution/sandbox/read-file.js");
    const bundle = state.ctx!.require(BundleKey);
    vi.spyOn(serialization, "deserializeContext").mockImplementation(async (data) => {
      const ctx = new ContextContainer();
      ctx.set(BundleKey, bundle);
      for (const [name, value] of Object.entries(data)) {
        const key = resolveKey(name);
        if (key !== undefined) ctx.set(key, structuredClone(value));
      }
      return ctx;
    });
    const todos = [{ content: "review", priority: "high" as const, status: "pending" as const }];
    const fs = { readTextFile: async () => "original" };
    state.tools.set(
      "todo",
      definition("todo", { execute: async () => executeTodoTool({ todos }) }),
    );
    state.tools.set(
      "read_file",
      definition("read_file", {
        execute: async () =>
          executeReadFileOnSandbox(fs as never, { filePath: "/workspace/probe.txt" }),
      }),
    );
    state.tools.set("noop_a", definition("noop_a"));
    state.tools.set("noop_b", definition("noop_b"));
    let current = {
      serializedContext: serialization.serializeContext(state.ctx!),
      sessionState: {} as never,
    };
    const snapshot = current;
    const invoke = (name: string) => settled(nestedInput(name, { ...snapshot, toolCallId: name }));

    const batch = await Promise.all(["todo", "read_file", "noop_a", "noop_b"].map(invoke));
    expect(batch.map((outcome) => outcome.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    // Plain tools must not surface framework-internal context churn as state.
    expect(batch[2]).not.toHaveProperty("stateChanges");
    expect(batch[3]).not.toHaveProperty("stateChanges");
    for (const outcome of batch) {
      current = adoptCodeModeStateChanges(current, outcome.stateChanges ?? []) as typeof current;
    }

    state.tools.set("todo", definition("todo", { execute: async () => executeTodoTool({}) }));
    const later = await settled(nestedInput("todo", { ...current, toolCallId: "later" }));
    expect(later).toMatchObject({ status: "completed", output: { todos } });
    expect(JSON.stringify(current.serializedContext)).toContain("/workspace/probe.txt");
  });
});
