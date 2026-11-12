import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import { defineDynamic } from "#dynamic/definition.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext, captureEvents } from "#internal/testing/entry-test-helpers.js";
import { filterEventsByType } from "#internal/testing/events.js";
import { startTestSession } from "#internal/testing/test-session-hosts.js";
import { resumeRoutedHook } from "#execution/hosts.js";
import { defineAgent } from "#public/definitions/agent.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { AuthorizationDefinition } from "#shared/connection-types.js";
import { defineTool } from "#tools/definition.js";

// Calls create_issue, which asks for a sign-in; after the steering message, calls it again.
const script: readonly ({ readonly tool: string } | { readonly text: string })[] = [
  { tool: "create_issue" },
  { tool: "create_issue" },
  { text: "That needs Issues access." },
  { tool: "create_issue" },
];
let scriptIndex = 0;
const alice = {
  attributes: {},
  authenticator: "test-idp",
  issuer: "test-idp",
  principalId: "user-1",
  principalType: "user",
};
const scriptedModel = markMockModel(
  new MockLanguageModelV4({
    doStream: async () => {
      const next = script[scriptIndex++] ?? { text: "Done." };
      return "text" in next
        ? textStreamResult(next.text)
        : toolCallStreamResult({
            input: "{}",
            toolCallId: `call-${scriptIndex}`,
            toolName: next.tool,
          });
    },
    modelId: "scripted-model",
    provider: "eve-test",
  }),
);

describe("workflowEntry cancelled sign-in", () => {
  // a message that cancels an open sign-in does not lead to a second sign-in card.
  it("does not ask again in the turn for a sign-in a new message cancelled", async () => {
    scriptIndex = 0;
    let starts = 0;
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
        throw new Error("The sign-in never completes in this test.");
      },
    };
    const runtime = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => ({
            model: scriptedModel,
            modelContextWindowTokens: 200_000,
          })),
        }),
        name: "workflow-entry-sign-in-cancelled",
      },
      modules: [
        {
          loadNamespace: async () => ({
            default: defineTool({
              description: "Run create_issue.",
              execute: async (_input, ctx) => ({ token: (await ctx.getToken(issuesAuth)).token }),
              inputSchema: {},
            }),
          }),
          logicalPath: "tools/create_issue.ts",
        },
      ],
    });
    const send = (runId: string, message: string) =>
      resumeRoutedHook(sessionInboxHookToken(sessionCommandHookToken(runId)), {
        auth: alice,
        kind: "send",
        delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
        payload: { message },
      });

    await runtime.run(async () => {
      const run = await startTestSession("in-process", {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: "Create an issue." },
        serializedContext: buildSerializedContext({
          auth: alice,
          channelKind: "http",
          continuationToken: "http:workflow-entry-sign-in-cancelled",
        }),
      });
      const stream = captureEvents(run);

      try {
        const asked = await stream.nextUntil("first sign-in", isSignInOpened);
        const required = filterEventsByType(asked, "interaction.opened").find(
          (event) => event.data.request.kind === "sign-in",
        )!.data;
        await stream.nextUntil("sign-in hold", (event) => event.type === "turn.paused");

        // A new message arrives while the card is up: it cancels the sign-in, and the model's
        // next create_issue call gets that cancellation instead of a second card.
        await send(run.runId, "Also add a label.");
        const resumed = await stream.nextUntil(
          "turn after the cancelled sign-in",
          (event) => event.type === "turn.settled" || isSignInOpened(event),
        );
        expect(resumed.filter(isSignInOpened)).toEqual([]);
        expect(starts).toBe(1);
        expect(resumed.at(-1)?.type).toBe("turn.settled");
        expect(filterEventsByType(resumed, "interaction.settled")).toContainEqual(
          expect.objectContaining({
            data: expect.objectContaining({
              interactionId: required.interactionId,
              outcome: "withdrawn",
            }),
          }),
        );
        const retried = filterEventsByType(resumed, "call.requested").find(
          (event) => event.data.capability.name === "create_issue",
        )?.data.callId;
        const refused = filterEventsByType(resumed, "call.settled").find(
          (event) => event.data.callId === retried,
        );
        expect(refused?.data.outcome).toBe("failed");
        expect(JSON.stringify(refused?.data)).toContain(
          "ended without being completed in this turn",
        );

        // The next turn may ask once, because the user's follow-up can still need it.
        await send(run.runId, "Try again, I'll sign in.");
        const nextTurn = await stream.nextUntil("next turn's sign-in", isSignInOpened);
        expect(nextTurn.filter(isSignInOpened)).toHaveLength(1);
        expect(starts).toBe(2);
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
