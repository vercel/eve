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

const alice = {
  attributes: {},
  authenticator: "test-idp",
  issuer: "test-idp",
  principalId: "user-1",
  principalType: "user",
};
// Calls create_issue for every new message, and answers in text once a tool result is in.
const scriptedModel = markMockModel(
  new MockLanguageModelV4({
    doStream: async ({ prompt }) =>
      prompt.at(-1)?.role === "tool"
        ? textStreamResult("That needs Issues access.")
        : toolCallStreamResult({
            input: "{}",
            toolCallId: `call-${prompt.length}`,
            toolName: "create_issue",
          }),
    modelId: "scripted-model",
    provider: "eve-test",
  }),
);
const schedule = { definition: "daily-issues" };

async function issuesRuntime(name: string) {
  const counts = { starts: 0 };
  const issuesAuth: AuthorizationDefinition<{ nonce: string }> = {
    principalType: "user",
    vercelConnect: { connector: "oauth/issues" },
    async getToken() {
      throw new ConnectionAuthorizationRequiredError("issues");
    },
    async startAuthorization({ callbackUrl }) {
      counts.starts += 1;
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
        model: defineDynamic(() => ({ model: scriptedModel, modelContextWindowTokens: 200_000 })),
      }),
      name,
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
  return { counts, runtime };
}

function send(runId: string, message: string, scheduled: boolean) {
  return resumeRoutedHook(sessionInboxHookToken(sessionCommandHookToken(runId)), {
    auth: alice,
    kind: "send",
    delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
    payload: { message },
    ...(scheduled && { schedule }),
  });
}

const turnEnd = (event: SessionStreamEvent) =>
  event.type === "turn.settled" || event.type === "turn.paused";

describe("workflowEntry scheduled sign-in", () => {
  // a schedule firing into a conversation posted a sign-in prompt on every firing.
  it("never asks across ten firings into a conversation, and asks once for the person", async () => {
    const { counts, runtime } = await issuesRuntime("scheduled-sign-in-conversation");
    await runtime.run(async () => {
      const run = await startTestSession("in-process", {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: "Firing 1: create today's issue." },
        serializedContext: {
          ...buildSerializedContext({
            auth: alice,
            channelKind: "http",
            continuationToken: "http:scheduled-sign-in-conversation",
          }),
          "eve.capabilities": { requestInput: true },
          "eve.scheduleId": schedule.definition,
        },
      });
      const stream = captureEvents(run);
      try {
        const seen = [...(await stream.nextUntil("firing 1", turnEnd))];
        for (let firing = 2; firing <= 10; firing += 1) {
          await send(run.runId, `Firing ${firing}: create today's issue.`, true);
          seen.push(...(await stream.nextUntil(`firing ${firing}`, turnEnd)));
        }
        expect(filterEventsByType(seen, "turn.settled")).toHaveLength(10);
        expect(seen.filter(isSignInOpened)).toEqual([]);
        expect(counts.starts).toBe(0);
        expect(JSON.stringify(filterEventsByType(seen, "call.settled").at(-1)?.data)).toContain(
          "isn't asked for in a scheduled run",
        );

        // The person's own message can still need it: it asks once.
        await send(run.runId, "Create it, I'll sign in.", false);
        const followUp = await stream.nextUntil("follow-up sign-in", isSignInOpened);
        expect(followUp.filter(isSignInOpened)).toHaveLength(1);
        expect(counts.starts).toBe(1);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 120_000);

  it("never asks in a scheduled session nobody can answer", async () => {
    const { counts, runtime } = await issuesRuntime("scheduled-sign-in-unattended");
    await runtime.run(async () => {
      const run = await startTestSession("in-process", {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: "Create today's issue." },
        serializedContext: {
          ...buildSerializedContext({
            auth: alice,
            channelKind: "schedule",
            continuationToken: "eve-scheduled-send:unattended",
          }),
          "eve.scheduleId": schedule.definition,
        },
      });
      const stream = captureEvents(run);
      try {
        const events = await stream.nextUntil("unattended turn", turnEnd);
        expect(events.at(-1)?.type).toBe("turn.settled");
        expect(events.filter(isSignInOpened)).toEqual([]);
        expect(counts.starts).toBe(0);
        expect(JSON.stringify(filterEventsByType(events, "call.settled").at(-1)?.data)).toContain(
          "isn't asked for in a scheduled run",
        );
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
