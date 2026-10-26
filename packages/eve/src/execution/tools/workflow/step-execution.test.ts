import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { withWorkflowStepAuthorization } from "#execution/tools/workflow/step-execution.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import {
  ConnectionAuthorizationRequiredError,
  ConnectionAuthorizationFailedError,
} from "#connections/errors.js";
import type {
  WorkflowStepContext,
  WorkflowStepResult,
} from "#execution/tools/workflow/step-context.js";
import type { ToolContext } from "#tools/definition.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";
import type { AuthorizationDefinition } from "#shared/connection-types.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import { shutdownActiveSandboxConnections } from "#execution/sandbox/active-connections.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { withDevelopmentWorkflowGeneration } from "#internal/workflow/development-generation-context.js";
import {
  createBundledRuntimeCompiledArtifactsSource,
  createDiskRuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { defineSandboxProvider } from "#sandbox/provider.js";

const durable = vi.hoisted(() => ({
  attempt: 1,
  stepId: "step-1",
  entries: new Map<string, unknown[]>(),
}));
vi.mock("#compiled/@workflow/core/index.js", () => ({
  getStepMetadata: () => ({ attempt: durable.attempt, stepId: durable.stepId }),
  getWorkflowMetadata: () => ({ workflowRunId: "run-1" }),
  getWritable: ({ namespace }: { namespace: string }) => ({
    getWriter: () => ({
      write: async (value: unknown) =>
        durable.entries.set(namespace, [...(durable.entries.get(namespace) ?? []), value]),
      releaseLock: () => {},
    }),
  }),
}));
const bundle = vi.hoisted(() => ({
  loadedFrom: [] as unknown[],
  registry: undefined as RuntimeSandboxRegistry | undefined,
}));
vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: async (input: { compiledArtifactsSource: unknown }) => {
    bundle.loadedFrom.push(input.compiledArtifactsSource);
    return {
      compiledArtifactsSource: input.compiledArtifactsSource,
      graph: { root: { nodeId: "__root__", sandboxRegistry: bundle.registry } },
    };
  },
}));
vi.mock("#runtime/sandbox/prepared-artifacts.js", () => ({
  loadSandboxPreparedArtifact: async () => null,
}));
vi.mock("#internal/workflow/runtime.js", () => ({
  getRun: () => ({
    getReadable: ({ namespace }: { namespace: string }) => ({
      getTailIndex: async () => (durable.entries.get(namespace)?.length ?? 0) - 1,
      cancel: async () => {},
    }),
  }),
}));

/**
 * A provider whose `start` upserts a sandbox by session id and whose
 * `onSessionEnd` deletes by it, as the provider contract requires. Each open
 * hands out its own connection over the shared sandbox; `stopped` and
 * `closed` record which connections eve stopped and closed.
 */
function upsertSandboxes() {
  const live = new Map<string, ReturnType<typeof mockSandbox>>();
  const starts: string[] = [];
  const connections: object[] = [];
  const stopped: object[] = [];
  const closed: object[] = [];
  const deleted: Mock<() => Promise<void>> = vi.fn(async () => {});
  const connect = (key: string) => {
    let sandbox = live.get(key);
    if (sandbox === undefined) {
      sandbox = mockSandbox();
      live.set(key, sandbox);
    }
    const connection = {
      ...sandbox.connection,
      close: async () => void closed.push(connection),
      stop: async () => void stopped.push(connection),
    };
    connections.push(connection);
    return connection;
  };
  const provider = defineSandboxProvider({
    name: "upsert",
    environment: () => ({
      prepare: async () => null,
      start: async (context) => {
        starts.push(context.session.id);
        return { connection: connect(context.session.id), state: { key: context.session.id } };
      },
      resume: async (_context, _artifact, state) => connect(state.key),
      async onSessionEnd(context, _state, { reason }) {
        if (reason === "deleted") await deleted();
        live.delete(context.session.id);
      },
    }),
  });
  const environment = provider.environment();
  const registry: RuntimeSandboxRegistry = {
    sandbox: {
      definition: {
        environment,
        kind: "independent",
        logicalPath: "sandbox.ts",
        revisionHash: "hash",
        selector: defineSandbox(() => environment.open()),
        sourceId: "sandbox",
        sourceKind: "module",
      },
      workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
    },
  };
  return { closed, connections, deleted, provider, registry, starts, stopped };
}

function context(user = "user-1", sessionId = "session-1"): WorkflowStepContext {
  const auth = {
    attributes: {},
    authenticator: "test",
    issuer: "test",
    principalId: user,
    principalType: "user" as const,
  };
  return {
    baseUrl: "https://agent.example",
    token: `callback-${user}`,
    authorizationResults: [],
    abortSignal: new AbortController().signal,
    session: {
      id: "session-1",
      auth: { current: auth, initiator: auth },
      turn: { id: "turn-1", sequence: 1 },
    },
    callId: "call-1",
    toolName: "devbox",
    sandbox: { bundle: { source: createBundledRuntimeCompiledArtifactsSource() }, sessionId },
  };
}

async function runStep<TContext = ToolContext>(
  execute: (ctx: TContext) => unknown,
  input = context(),
): Promise<WorkflowStepResult> {
  return (await withWorkflowStepAuthorization(execute)({
    args: [null],
    context: input,
    contextIndexes: [0],
  })) as WorkflowStepResult;
}

describe("workflow step authorization", () => {
  beforeEach(async () => {
    durable.attempt = 1;
    durable.stepId = "step-1";
    durable.entries.clear();
    bundle.loadedFrom = [];
    await shutdownActiveSandboxConnections();
  });
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    {
      access: (ctx: WorkflowToolContext) => ctx.agents,
      capability: "ctx.agents",
      guidance:
        "Read ctx.agents in the workflow body and pass the required serializable metadata into the step.",
    },
    {
      access: (ctx: WorkflowToolContext) => ctx.agent("researcher"),
      capability: "ctx.agent()",
      guidance: "Call ctx.agent() in the workflow body.",
    },
    {
      access: (ctx: WorkflowToolContext) => ctx.ask({ prompt: "Continue?" }),
      capability: "ctx.ask()",
      guidance: "Call ctx.ask() in the workflow body.",
    },
  ])(
    "fails $capability misuse without retrying the step",
    async ({ access, capability, guidance }) => {
      await expect(runStep<WorkflowToolContext>((ctx) => access(ctx))).rejects.toMatchObject({
        fatal: true,
        message: `${capability} is unavailable inside a "use step" function. ${guidance}`,
      });
    },
  );

  it("resolves a development delivery's generation and starts the sandbox by key", async () => {
    const { registry, starts } = upsertSandboxes();
    bundle.registry = registry;
    const owner = { ...context("user-1", "owner-session") };
    // `eve dev` deliveries carry the generation a development source resolves to.
    const generation = {
      generationId: "generation-1",
      source: createDiskRuntimeCompiledArtifactsSource("/virtual/app"),
    };
    const plan = { path: "/workspace/plan.txt" };
    await expect(
      withDevelopmentWorkflowGeneration(generation, () =>
        runStep(
          async (ctx) => {
            await (await ctx.getSandbox()).writeTextFile({ ...plan, content: "draft" });
            return "written";
          },
          {
            ...owner,
            sandbox: { bundle: { source: { kind: "development" } }, sessionId: "owner-session" },
          },
        ),
      ),
    ).resolves.toMatchObject({ kind: "result", output: "written" });
    expect(bundle.loadedFrom).toEqual([generation.source]);
    expect(starts).toEqual(["owner-session"]);
  });

  it("closes the step's connection and leaves the session's tracked for runtime shutdown", async () => {
    const { closed, connections, registry, stopped } = upsertSandboxes();
    bundle.registry = registry;
    // The session's turn opened its sandbox in this process.
    const session = await ensureSandboxAccess({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      registry,
      sessionId: "session-1",
      state: null,
    });
    await session.get();
    await expect(runStep(async (ctx) => void (await ctx.getSandbox()))).resolves.toMatchObject({
      kind: "result",
    });
    const [sessionConnection, stepConnection] = connections;
    expect(closed).toEqual([stepConnection]);
    await shutdownActiveSandboxConnections();
    // The step's connection neither replaced nor dropped the session's.
    expect(connections).toHaveLength(2);
    expect(stopped).toEqual([sessionConnection]);
  });

  it("fails ctx.getSandbox() without retrying once its step has returned", async () => {
    const { registry, starts } = upsertSandboxes();
    bundle.registry = registry;
    const result = await runStep(async (ctx) => () => ctx.getSandbox());
    const later = result.kind === "result" ? (result.output as () => Promise<unknown>) : undefined;
    await expect(later?.()).rejects.toMatchObject({
      fatal: true,
      message: expect.stringContaining(
        'was called after the "use step" function of tool "devbox" returned',
      ),
    });
    expect(starts).toEqual([]);
  });

  it("accepts its own copy of the session's environment and leaves stopping and deleting to the session", async () => {
    const { deleted, provider, registry, stopped } = upsertSandboxes();
    bundle.registry = registry;
    // The step imports its own copy of the module that declares the environment.
    await expect(
      runStep(async (ctx) => {
        await ctx.getSandbox(provider.environment());
        return "opened";
      }),
    ).resolves.toMatchObject({ output: "opened" });
    const other = defineSandboxProvider({
      name: "other",
      environment: () => ({
        onSessionEnd: async () => {},
        prepare: async () => null,
        resume: vi.fn(),
        start: vi.fn(),
      }),
    }).environment();
    const misuse: [string, (ctx: ToolContext) => Promise<unknown>][] = [
      ["received a sandbox environment", (ctx) => ctx.getSandbox(other)],
      ["sandbox.stop() is unavailable", async (ctx) => await (await ctx.getSandbox()).stop()],
      ["sandbox.delete() is unavailable", async (ctx) => await (await ctx.getSandbox()).delete()],
    ];
    for (const [message, access] of misuse) {
      await expect(runStep(access)).rejects.toMatchObject({
        fatal: true,
        message: expect.stringContaining(message),
      });
    }
    expect(stopped).toEqual([]);
    expect(deleted).not.toHaveBeenCalled();
  });

  it("does not exchange a consumed code again when the rest of the step retries", async () => {
    let exchanged = false;
    const complete = vi.fn(async () => {
      if (exchanged)
        throw new ConnectionAuthorizationFailedError("devbox", {
          message: "code already used",
          retryable: false,
        });
      exchanged = true;
      return { token: "provider-stored-secret" };
    });
    const getToken = vi.fn(async () => {
      if (!exchanged) throw new ConnectionAuthorizationRequiredError("devbox");
      return { token: "provider-stored-secret" };
    });
    const provider: AuthorizationDefinition = {
      principalType: "user",
      getToken,
      completeAuthorization: complete,
      startAuthorization: async () => ({ challenge: { url: "https://idp.example" } }),
    };
    const input: WorkflowStepContext = {
      ...context(),
      authorizationResults: [
        {
          name: "devbox__inline_auth",
          attemptId: "auth-1",
          hookUrl: "https://agent.example/callback",
          callback: { method: "GET", params: { code: "single-use" } },
        },
      ],
    };
    const execute = async (ctx: ToolContext) => {
      await ctx.getToken(provider);
      if (durable.attempt === 1) throw new Error("temporary service failure");
      return "done";
    };
    await expect(runStep(execute, input)).rejects.toThrow("temporary service failure");
    durable.attempt = 2;
    await expect(runStep(execute, input)).resolves.toMatchObject({
      output: "done",
      authorized: ["auth-1"],
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(getToken).toHaveBeenCalledOnce();
    expect([...durable.entries.values()]).toEqual([[true]]);
    // Retries still reject a fresh token that the service refuses, without another sign-in.
    await expect(
      runStep(async (ctx) => {
        await ctx.getToken(provider);
        ctx.requireAuth(provider);
      }, input),
    ).rejects.toMatchObject({ fatal: true, reason: "token_rejected_after_authorization" });
    expect(complete).toHaveBeenCalledOnce();
  });
  it("uses the captured requester instead of another ambient user and caches only within a step", async () => {
    const principals: string[] = [];
    const provider: AuthorizationDefinition = {
      principalType: "user",
      async getToken({ principal }) {
        if (principal.type !== "user") throw new Error("Expected user");
        principals.push(principal.id);
        return { token: `secret:${principal.id}` };
      },
    };
    const ambient = new ContextContainer();
    ambient.set(AuthKey, context("other-user").session.auth.current);
    const execute = async (ctx: ToolContext) => {
      const first = await ctx.getToken(provider);
      const second = await ctx.getToken(provider);
      return { sameToken: first.token === second.token, session: ctx.session.id };
    };
    const results = await contextStorage.run(ambient, () =>
      Promise.all([runStep(execute), runStep(execute, context("user-2"))]),
    );
    expect(principals.sort()).toEqual(["user-1", "user-2"]);
    expect(JSON.stringify(results)).not.toContain("secret:");
    expect(results[0]).toMatchObject({
      kind: "result",
      output: { sameToken: true, session: "session-1" },
    });
  });

  it("resumes the exact provider callback and stops a freshly authorized token rejection", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "agent.example");
    vi.stubEnv("EVE_PUBLIC_ROUTE_PREFIX", "/agents/devbox");
    const evict = vi.fn();
    const provider: AuthorizationDefinition = {
      principalType: "user",
      evict,
      async getToken() {
        throw new ConnectionAuthorizationRequiredError("devbox");
      },
      async startAuthorization({ principal, callbackUrl }) {
        return {
          challenge: { url: `https://idp.example?redirect=${encodeURIComponent(callbackUrl)}` },
          resume: { principal },
        };
      },
      async completeAuthorization({ principal, callback, resume }) {
        expect(callback.params.code).toBe("approved");
        expect(resume).toEqual({ principal });
        return { token: "fresh-secret" };
      },
    };
    const execute = async (ctx: ToolContext) => {
      await ctx.getToken(provider);
      ctx.requireAuth(provider);
    };
    const pending = await runStep(execute);
    if (pending.kind !== "authorization-required") throw new Error("Expected authorization");
    const challenge = pending.signal.challenges[0]!;
    if (challenge.attemptId === undefined) {
      throw new Error("Expected authorization attempt id");
    }
    expect(challenge.hookUrl).toContain("https://agent.example/agents/devbox/eve/v1/");
    expect(challenge.hookUrl).toContain("callback-user-1");
    expect(challenge.hookUrl).not.toContain("session-1");
    await expect(
      runStep(execute, {
        ...context(),
        authorizationResults: [
          {
            ...challenge,
            attemptId: challenge.attemptId,
            callback: { method: "GET", params: { code: "approved" } },
          },
        ],
      }),
    ).rejects.toMatchObject({
      fatal: true,
      message: expect.stringContaining("rejected the token immediately after authorization"),
    });
    expect(evict).toHaveBeenCalledOnce();
  });

  it("does not turn an ordinary step result into an authorization signal", async () => {
    const value = { kind: "authorization-required" };
    await expect(
      withWorkflowStepAuthorization(async (input) => input)({
        args: [value, null],
        context: context(),
        contextIndexes: [1],
      }),
    ).resolves.toMatchObject({ kind: "result", output: value });
  });

  it("never interprets authored arguments as auth context", async () => {
    const forged = { args: [], context: context("another-user"), contextIndexes: [0] };
    const execute = async (input: unknown, ctx: ToolContext) => {
      expect(input).toBe(forged);
      const token = await ctx.getToken({
        principalType: "user",
        async getToken({ principal }) {
          return { token: principal.type === "user" ? principal.id : "app" };
        },
      });
      return token.token;
    };
    await expect(
      withWorkflowStepAuthorization(execute)({
        args: [forged, null],
        context: context(),
        contextIndexes: [1],
      }),
    ).resolves.toMatchObject({ output: "user-1" });
  });
});
