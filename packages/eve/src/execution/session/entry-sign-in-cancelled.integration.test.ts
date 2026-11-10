import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
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
import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { AuthorizationDefinition } from "#shared/connection-types.js";
import { defineTool } from "#tools/definition.js";

// Calls create_issue, which asks for a sign-in. After the person's message, drops the call that
// waits on it, calls it again, and replies.
type Turn = { readonly tool: string; readonly input?: object } | { readonly text: string };
const script: readonly ((prompt: string) => Turn)[] = [
  () => ({ tool: "create_issue" }),
  (prompt) => ({
    input: { taskId: /Started task ([\w-]+)\./u.exec(prompt)?.[1] },
    tool: "eve__task_cancel",
  }),
  () => ({ tool: "create_issue" }),
  () => ({ text: "That needs Issues access." }),
  () => ({ tool: "create_issue" }),
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
    doStream: async ({ prompt }) => {
      const next = script[scriptIndex++]?.(JSON.stringify(prompt)) ?? { text: "Done." };
      return "text" in next
        ? textStreamResult(next.text)
        : toolCallStreamResult({
            input: JSON.stringify(next.input ?? {}),
            toolCallId: `call-${scriptIndex}`,
            toolName: next.tool,
          });
    },
    modelId: "scripted-model",
    provider: "eve-test",
  }),
);

describe("workflowEntry cancelled sign-in", () => {
  // A sign-in the model dropped with its waiting call does not lead to a second sign-in card.
  it("does not ask again in the turn for a sign-in the model dropped", async () => {
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
      resumeHook(sessionInboxHookToken(sessionCommandHookToken(runId)), {
        auth: alice,
        kind: "send",
        delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
        payload: { message },
      });

    await runtime.run(async () => {
      const run = await startSessionOwner(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "Create an issue." },
          serializedContext: buildSerializedContext({
            auth: alice,
            channelKind: "http",
            continuationToken: "http:workflow-entry-sign-in-cancelled",
          }),
        },
      ]);
      const stream = captureEvents(run);

      try {
        const asked = await stream.nextUntil("first sign-in", isSignInOpened);
        const required = filterEventsByType(asked, "interaction.opened").find(
          (event) => event.data.request.kind === "sign-in",
        )!.data;
        await stream.nextUntil("sign-in hold", (event) => event.type === "turn.paused");

        // A new message arrives while the card is up: the call waits on the sign-in as a task,
        // which the model drops, and its next create_issue call is told the sign-in ended
        // instead of getting a second card.
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
