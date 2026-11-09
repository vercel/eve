import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
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
import { defineChannel, POST } from "#public/definitions/channel.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { AuthorizationDefinition } from "#shared/connection-types.js";
import { defineTool } from "#tools/definition.js";

interface PromptState {
  prompts: Record<string, string>;
  seeded: string;
}

/** The channel state each sign-in's `interaction.settled` handler saw. */
let statesAtSettle: PromptState[] = [];

const promptChannel = defineChannel({
  state: { prompts: {}, seeded: "" } as PromptState,
  context: (state) => ({ state }),
  events: {
    async "interaction.settled"(_event, ctx) {
      statesAtSettle.push(JSON.parse(JSON.stringify(ctx.channel.state)) as PromptState);
    },
  },
  routes: [POST("/test", async () => new Response("ok"))],
});

const alice = {
  attributes: {},
  authenticator: "test-idp",
  issuer: "test-idp",
  principalId: "user-1",
  principalType: "user",
};

let scriptIndex = 0;
const scriptedModel = markMockModel(
  new MockLanguageModelV4({
    doStream: async () =>
      scriptIndex++ === 0
        ? toolCallStreamResult({ input: "{}", toolCallId: "call-1", toolName: "list_issues" })
        : textStreamResult("Done."),
    modelId: "scripted-model",
    provider: "eve-test",
  }),
);

const issuesAuth: AuthorizationDefinition<{ nonce: string }> = {
  principalType: "user",
  vercelConnect: { connector: "oauth/issues" },
  async getToken() {
    throw new ConnectionAuthorizationRequiredError("issues");
  },
  async startAuthorization({ callbackUrl }) {
    return {
      challenge: { displayName: "Issues", url: `https://idp.example/authorize?cb=${callbackUrl}` },
      resume: { nonce: "issues-nonce" },
    };
  },
  async completeAuthorization() {
    return { token: "after-signin" };
  },
};

describe("channel-state control", () => {
  it("patches the channel state of a turn held on a sign-in, for the step that settles it", async () => {
    scriptIndex = 0;
    statesAtSettle = [];
    const runtime = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => ({ model: scriptedModel, modelContextWindowTokens: 200_000 })),
        }),
        name: "channel-state-sign-in",
      },
      modules: [
        {
          loadNamespace: async () => ({ default: promptChannel }),
          logicalPath: "channels/prompts.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineTool({
              description: "List issues.",
              execute: async (_input, ctx) => ({ token: (await ctx.getToken(issuesAuth)).token }),
              inputSchema: {},
            }),
          }),
          logicalPath: "tools/list_issues.ts",
        },
      ],
    });

    await runtime.run(async () => {
      const run = await startSessionOwner(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "List my issues." },
          serializedContext: buildSerializedContext({
            auth: alice,
            channelKind: "channel:prompts",
            channelState: { prompts: {}, seeded: "kept" },
            continuationToken: "prompts:channel-state-sign-in",
          }),
        },
      ]);
      const stream = captureEvents(run);
      const inbox = sessionInboxHookToken(sessionCommandHookToken(run.runId));

      try {
        const asked = await stream.nextUntil("sign-in", isSignInOpened);
        const signIn = filterEventsByType(asked, "interaction.opened").find(
          (event) => event.data.request.kind === "sign-in",
        )!.data;
        await stream.nextUntil("sign-in hold", (event) => event.type === "turn.paused");

        await resumeHook(inbox, {
          deliveryId: "patch-1",
          kind: "channel-state",
          state: { prompts: { issues: "https://hooks.slack.com/actions/1" } },
        });
        const patched = await stream.nextUntil(
          "patch settled",
          (event) => event.type === "delivery.settled" && event.data.deliveryId === "patch-1",
        );
        expect(patched.at(-1)).toMatchObject({ data: { outcome: "applied" } });
        // A control with no sender names no principal, so the held turn's stays its own.
        expect(
          filterEventsByType(patched, "delivery.admitted").find(
            (event) => event.data.deliveryId === "patch-1",
          )?.data,
        ).toEqual({ deliveryId: "patch-1", source: { control: "channel-state" } });
        expect(filterEventsByType(patched, "turn.settled")).toEqual([]);

        await resumeHook(inbox, {
          kind: "authorization-callback",
          payloads: [
            {
              authorizationCallback: {
                attemptId: signIn.interactionId,
                callback: { method: "GET", params: { code: "oauth-code" } },
                connectionName: signIn.request.signIn!.name,
              },
            },
          ],
        });
        const resumed = await stream.nextUntil(
          "turn after the sign-in",
          (event) => event.type === "turn.settled",
        );

        expect(filterEventsByType(resumed, "interaction.settled")).toContainEqual(
          expect.objectContaining({
            data: expect.objectContaining({
              interactionId: signIn.interactionId,
              outcome: "accepted",
            }),
          }),
        );
        expect(statesAtSettle).toContainEqual({
          prompts: { issues: "https://hooks.slack.com/actions/1" },
          seeded: "kept",
        });
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });
});

function isSignInOpened(event: SessionStreamEvent): boolean {
  return event.type === "interaction.opened" && event.data.request.kind === "sign-in";
}
