import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
} from "#connections/errors.js";
import { defineDynamic } from "#dynamic/definition.js";
import { handleConnectionCallbackRequest } from "#execution/connections/callback-route.js";
import { workflowEntry } from "#execution/session/entry.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { type CapturedEventStream, captureEvents } from "#internal/testing/entry-test-helpers.js";
import { filterEventsByType } from "#internal/testing/events.js";
import {
  failedSignInWorkflow,
  signInAWorkflow,
  signInThenFailWorkflow,
} from "#internal/testing/workflow-tool-fixtures.js";
import { buildWorkflowToolSerializedContext } from "#internal/testing/workflow-tool-run-harness.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { defineAgent } from "#public/definitions/agent.js";
import type { AuthorizationDefinition } from "#shared/connection-types.js";
import { defineTool } from "#tools/definition.js";
import type { WorkflowExecuteToolDefinition } from "#tools/workflow-definition.js";
import { defineWorkflowTool } from "#tools/workflow-definition.js";

type ToolKind = "ordinary" | "workflow step";

// The model calls `first`, then `second`, then replies.
let script: readonly string[] = [];
let scriptIndex = 0;
const scriptedModel = markMockModel(
  new MockLanguageModelV4({
    doStream: async () => {
      const tool = script[scriptIndex++];
      return tool === undefined
        ? textStreamResult("All done.")
        : toolCallStreamResult({ input: "{}", toolCallId: `call-${scriptIndex}`, toolName: tool });
    },
    modelId: "scripted-model",
    provider: "eve-test",
  }),
);

function interactive(
  connector: string,
  completeAuthorization: NonNullable<AuthorizationDefinition["completeAuthorization"]>,
): AuthorizationDefinition {
  return {
    principalType: "user",
    vercelConnect: { connector },
    async getToken() {
      throw new ConnectionAuthorizationRequiredError(connector);
    },
    async startAuthorization({ callbackUrl }) {
      return {
        challenge: {
          displayName: connector,
          url: `https://idp.example/authorize?cb=${callbackUrl}`,
        },
        resume: { nonce: "nonce" },
      };
    },
    completeAuthorization,
  };
}

// The same providers as the workflow fixtures' steps, for ordinary tools.
const issuesAuth = interactive("oauth/issues", async () => {
  throw new ConnectionAuthorizationFailedError("issues", {
    message: "Authorization did not complete.",
    reason: "authorization_incomplete",
    retryable: false,
  });
});
const aAuth = interactive("oauth/a", async () => ({ token: "a-token" }));
const bAuth: AuthorizationDefinition = {
  principalType: "user",
  async getToken() {
    throw new ConnectionAuthorizationFailedError("b", {
      message: "B is not installed.",
      reason: "b_not_installed",
      retryable: false,
    });
  },
};

const ordinary = {
  failedSignIn: async (ctx: Parameters<Parameters<typeof defineTool>[0]["execute"]>[1]) =>
    (await ctx.getToken(issuesAuth)).token,
  signInA: async (ctx: Parameters<Parameters<typeof defineTool>[0]["execute"]>[1]) =>
    (await ctx.getToken(aAuth)).token,
  signInThenFail: async (ctx: Parameters<Parameters<typeof defineTool>[0]["execute"]>[1]) =>
    `${(await ctx.getToken(aAuth)).token}:${(await ctx.getToken(bAuth)).token}`,
};
const workflows = {
  failedSignIn: failedSignInWorkflow,
  signInA: signInAWorkflow,
  signInThenFail: signInThenFailWorkflow,
};

function tool(name: string, kind: ToolKind, body: keyof typeof ordinary) {
  return {
    loadNamespace: async () => ({
      default:
        kind === "ordinary"
          ? defineTool({
              description: `Run ${name}.`,
              execute: async (_input, ctx) => ({ token: await ordinary[body](ctx) }),
              inputSchema: {},
            })
          : defineWorkflowTool({
              description: `Run ${name}.`,
              execute: workflows[body] as WorkflowExecuteToolDefinition["execute"],
              inputSchema: { properties: {}, type: "object" },
            }),
    }),
    logicalPath: `tools/${name}.ts`,
  };
}

/** Runs one turn that calls `first`, then `second`, signing in once when first asked. */
async function runTurn(
  modules: readonly ReturnType<typeof tool>[],
  check: (afterSignIn: readonly MessageStreamEvent[]) => void,
): Promise<void> {
  scriptIndex = 0;
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic({
          events: {
            "step.started": () => ({ model: scriptedModel, modelContextWindowTokens: 200_000 }),
          },
        }),
      }),
      name: "workflow-step-sign-in-failure",
    },
    modules: [...modules],
  });

  await runtime.run(async () => {
    const run = await startSessionOwner(workflowEntry, [
      {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: "Run both tools." },
        serializedContext: {
          ...buildWorkflowToolSerializedContext({
            continuationToken: "http:workflow-step-sign-in-failure",
            requestInput: true,
          }),
          "eve.auth": {
            attributes: {},
            authenticator: "test-idp",
            issuer: "test-idp",
            principalId: "user-1",
            principalType: "user",
          },
        },
      },
    ]);
    const stream = captureEvents(run);
    try {
      await signIn(stream);
      check(
        await stream.nextUntil(
          "turn after the sign-in",
          (event) => event.type === "session.waiting" || event.type === "authorization.required",
        ),
      );
    } finally {
      stream.dispose();
      await run.cancel();
    }
  });
}

async function signIn(stream: CapturedEventStream): Promise<void> {
  const asked = await stream.nextUntil(
    "first sign-in",
    (event) => event.type === "authorization.required",
  );
  const required = filterEventsByType(asked, "authorization.required")[0]!.data;
  await stream.nextUntil("sign-in hold", (event) => event.type === "turn.waiting");
  const url = new URL(required.webhookUrl!);
  url.searchParams.set("code", "oauth-code");
  const token = url.pathname.split("/").map(decodeURIComponent).at(-1)!;
  const response = await handleConnectionCallbackRequest(new Request(url), {
    params: { attemptId: required.attemptId!, name: required.name, token },
  } as never);
  expect(response.status).toBe(200);
}

describe("workflow step sign-in failure", () => {
  // #4943 for tools that sign in from a workflow step.
  it.each<[ToolKind, ToolKind]>([
    ["workflow step", "workflow step"],
    ["ordinary", "workflow step"],
    ["workflow step", "ordinary"],
  ])(
    "a %s sign-in that fails with retryable: false stops a %s tool on the same grant from prompting",
    async (first, second) => {
      script = ["list_issues", "create_issue"];
      await runTurn(
        [tool("list_issues", first, "failedSignIn"), tool("create_issue", second, "failedSignIn")],
        (resumed) => {
          expect(
            filterEventsByType(resumed, "authorization.completed").map(({ data }) => data),
          ).toContainEqual(expect.objectContaining({ outcome: "failed", retryable: false }));
          expect(filterEventsByType(resumed, "authorization.required")).toEqual([]);
          expect(resumed.at(-1)?.type).toBe("session.waiting");
          expect(
            filterEventsByType(resumed, "action.result").map(({ data }) => data.result),
          ).toContainEqual(
            expect.objectContaining({
              isError: true,
              output: expect.stringContaining("already failed in this turn"),
              toolName: "create_issue",
            }),
          );
        },
      );
    },
    60_000,
  );

  it.each<ToolKind>(["workflow step", "ordinary"])(
    "a %s call's terminal failure after a sign-in completes doesn't block that sign-in",
    async (kind) => {
      script = ["sync", "read_a"];
      await runTurn(
        [tool("sync", kind, "signInThenFail"), tool("read_a", kind, "signInA")],
        (resumed) => {
          const [completed] = filterEventsByType(resumed, "authorization.completed").map(
            ({ data }) => data,
          );
          // A workflow step knows which sign-ins completed before its call failed; an ordinary
          // call reports them failed, but not with the other sign-in's retryable: false.
          expect(completed).toMatchObject(
            kind === "workflow step"
              ? { grant: "oauth/a", outcome: "authorized" }
              : { grant: "oauth/a", outcome: "failed", reason: "b_not_installed" },
          );
          expect(completed).not.toHaveProperty("retryable");
          expect(
            filterEventsByType(resumed, "authorization.required").map(({ data }) => data.name),
          ).toEqual(["read_a__oauth_a"]);
        },
      );
    },
    60_000,
  );
});
