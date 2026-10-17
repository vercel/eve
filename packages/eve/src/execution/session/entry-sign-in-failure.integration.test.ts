import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
} from "#connections/errors.js";
import { defineDynamic } from "#dynamic/definition.js";
import { workflowEntry } from "#execution/session/entry.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext, captureEvents } from "#internal/testing/entry-test-helpers.js";
import { filterEventsByType } from "#internal/testing/events.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { defineAgent } from "#public/definitions/agent.js";
import type { AuthorizationDefinition } from "#shared/connection-types.js";
import { defineTool } from "#tools/definition.js";

// Calls list_issues, then create_issue, once each, then replies.
const scriptedModel = markMockModel(
  new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const done = new Set(
        prompt.flatMap((message) =>
          message.role === "tool"
            ? message.content.flatMap((part) =>
                part.type === "tool-result" ? [part.toolName] : [],
              )
            : [],
        ),
      );
      const next = ["list_issues", "create_issue"].find((name) => !done.has(name));
      return next === undefined
        ? textStreamResult("All done.")
        : toolCallStreamResult({ input: "{}", toolCallId: `call-${next}`, toolName: next });
    },
    modelId: "scripted-model",
    provider: "eve-test",
  }),
);

describe("workflowEntry sign-in failure", () => {
  // #4943: the failed sign-in is forgotten, so create_issue starts a fresh one.
  it.fails("does not prompt again for a grant whose sign-in failed with retryable: false", async () => {
    let starts = 0;
    let completes = 0;
    // One Vercel Connect connector shared by two tools; the exchange never yields a token.
    const issuesAuth: AuthorizationDefinition<{ nonce: string }> = {
      principalType: "user",
      vercelConnect: { connector: "oauth/issues" },
      async getToken() {
        throw new ConnectionAuthorizationRequiredError("issues");
      },
      async startAuthorization({ callbackUrl }) {
        starts += 1;
        return {
          challenge: {
            displayName: "Issues",
            url: `https://idp.example/authorize?cb=${callbackUrl}`,
          },
          resume: { nonce: "issues-nonce" },
        };
      },
      async completeAuthorization() {
        completes += 1;
        throw new ConnectionAuthorizationFailedError("issues", {
          message: "Authorization did not complete.",
          reason: "authorization_incomplete",
          retryable: false,
        });
      },
    };
    const issuesTool = (name: string) => ({
      loadNamespace: async () => ({
        default: defineTool({
          description: `Run ${name}.`,
          execute: async (_input, ctx) => ({ token: (await ctx.getToken(issuesAuth)).token }),
          inputSchema: {},
        }),
      }),
      logicalPath: `tools/${name}.ts`,
    });
    const runtime = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic({
            events: {
              "step.started": () => ({ model: scriptedModel, modelContextWindowTokens: 200_000 }),
            },
          }),
        }),
        name: "workflow-entry-sign-in-failure",
      },
      modules: [issuesTool("list_issues"), issuesTool("create_issue")],
    });

    await runtime.run(async () => {
      const run = await startSessionOwner(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "List my issues, then create one." },
          serializedContext: buildSerializedContext({
            auth: {
              attributes: {},
              authenticator: "test-idp",
              issuer: "test-idp",
              principalId: "user-1",
              principalType: "user",
            },
            channelKind: "http",
            continuationToken: "http:workflow-entry-sign-in-failure",
          }),
        },
      ]);
      const stream = captureEvents(run);

      try {
        const asked = await stream.nextUntil(
          "first sign-in",
          (event) => event.type === "authorization.required",
        );
        const required = filterEventsByType(asked, "authorization.required")[0]!.data;
        await stream.nextUntil("sign-in hold", (event) => event.type === "turn.waiting");

        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          kind: "authorization-callback",
          payloads: [
            {
              authorizationCallback: {
                attemptId: required.attemptId,
                callback: { method: "GET", params: { code: "oauth-code" } },
                connectionName: required.name,
              },
            },
          ],
        });

        // The exchange failed terminally: create_issue, on the same grant, gets that failure
        // instead of a fresh sign-in, and the turn ends.
        const resumed = await stream.nextUntil(
          "turn after the failed sign-in",
          (event) => event.type === "session.waiting" || event.type === "authorization.required",
        );
        expect(completes).toBe(1);
        expect(filterEventsByType(resumed, "authorization.required")).toEqual([]);
        expect(starts).toBe(1);
        expect(resumed.at(-1)?.type).toBe("session.waiting");
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });
});
