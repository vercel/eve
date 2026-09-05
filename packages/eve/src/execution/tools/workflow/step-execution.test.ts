import { afterEach, describe, expect, it, vi } from "vitest";
import { withWorkflowStepAuthorization } from "#execution/tools/workflow/step-execution.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import type {
  WorkflowStepContext,
  WorkflowStepResult,
} from "#execution/tools/workflow/step-context.js";
import type { ToolContext } from "#tools/definition.js";
import type { AuthorizationDefinition } from "#shared/connection-types.js";

vi.mock("#compiled/@workflow/core/index.js", () => ({ getStepMetadata: () => ({ attempt: 1 }) }));

function context(user = "user-1"): WorkflowStepContext {
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
    from: {
      callId: "call-1",
      execution: "background",
      input: {},
      runId: "run-1",
      sequence: 1,
      stepIndex: 0,
      toolName: "devbox",
      turnId: "turn-1",
    },
    owner: { inbox: "owner" },
  };
}

async function runStep(
  execute: (ctx: ToolContext) => unknown,
  input = context(),
): Promise<WorkflowStepResult> {
  return (await withWorkflowStepAuthorization(execute)({
    args: [null],
    context: input,
    contextIndexes: [0],
  })) as WorkflowStepResult;
}

describe("workflow step authorization", () => {
  afterEach(() => vi.unstubAllEnvs());
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
      kind: "eve:workflow-step-result",
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
    if (pending.kind !== "eve:workflow-step-authorization")
      throw new Error("Expected authorization");
    const challenge = pending.signal.challenges[0]!;
    expect(challenge.hookUrl).toContain("https://agent.example/agents/devbox/eve/v1/");
    expect(challenge.hookUrl).toContain("callback-user-1");
    expect(challenge.hookUrl).not.toContain("session-1");
    await expect(
      runStep(execute, {
        ...context(),
        authorizationResults: [
          { ...challenge, callback: { method: "GET", params: { code: "approved" } } },
        ],
      }),
    ).rejects.toMatchObject({
      fatal: true,
      message: expect.stringContaining("rejected the token immediately after authorization"),
    });
    expect(evict).toHaveBeenCalledOnce();
  });

  it("does not turn an ordinary step result into an authorization signal", async () => {
    const value = { kind: "eve:workflow-step-authorization" };
    await expect(
      withWorkflowStepAuthorization(async (input) => input)({ args: [value] }),
    ).resolves.toBe(value);
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
    await expect(
      withWorkflowStepAuthorization(async (input) => input)({ args: [forged] }),
    ).resolves.toBe(forged);
  });
});
