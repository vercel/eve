import { describe, expect, it } from "vitest";
import type { SessionAuthContext } from "#channel/types.js";
import { workflowEntry } from "#execution/workflow-entry.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { resumeHook, start } from "#internal/workflow/runtime.js";
import { defineHook } from "#public/definitions/hook.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

const user: SessionAuthContext = {
  authenticator: "test",
  principalType: "user",
  principalId: "user-a",
  attributes: {},
};
const operator: SessionAuthContext = {
  authenticator: "oidc",
  principalType: "service",
  principalId: "operator",
  attributes: {},
};

describe("approval delivery execution identity", () => {
  it.each([
    { queued: false, caller: user },
    { queued: true, caller: user },
    { queued: true, caller: { ...user, principalId: "user-b" } },
  ])(
    "keeps $caller.principalId execution after operator continuation (queued=$queued)",
    async ({ queued, caller }) => {
      const completedCallers: Array<SessionAuthContext | null> = [];
      const runtime = await createTestRuntime({
        agent: { name: "approval-caller", limits: { maxInputTokensPerSession: 1 } },
        modules: [
          {
            logicalPath: "hooks/capture-caller.ts",
            loadNamespace: async () => ({
              default: defineHook({
                events: {
                  "message.completed"(_event, ctx) {
                    completedCallers.push(ctx.session.auth.current);
                  },
                },
              }),
            }),
          },
        ],
      });
      const token = `http:approval-caller-${queued}-${caller.principalId}`;
      await runtime.run(async () => {
        const run = await start(workflowEntry, [
          {
            input: { message: "Hello" },
            serializedContext: {
              "eve.auth": user,
              "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
              "eve.channel": { kind: "http", state: {} },
              "eve.continuationToken": token,
              "eve.mode": "conversation",
            },
          },
        ]);
        const stream = captureTurnEvents(run);
        try {
          await stream.nextTurn();
          await resumeHook(token, { kind: "send", auth: caller, payload: { message: "Continue" } });
          const parked = await stream.nextTurn();
          const request = filterEventsByType(parked, "input.requested")[0]?.data.requests[0];
          expect(request?.kind).toBe("session-limit");
          if (!request) throw new Error("Expected a session-limit request");
          if (queued)
            await resumeHook(token, {
              kind: "send",
              auth: caller,
              payload: { message: "Please report the problem" },
            });
          await resumeHook(token, {
            kind: "send",
            auth: operator,
            payload: { inputResponses: [{ requestId: request.requestId, optionId: "continue" }] },
          });
          for (let i = 0; i < 4 && completedCallers.length < 2; i++) await stream.nextTurn();
          expect(completedCallers.length).toBeGreaterThanOrEqual(2);
          expect(
            completedCallers
              .slice(1)
              .every((observed) => observed?.principalId === caller.principalId),
          ).toBe(true);
        } finally {
          stream.dispose();
          await run.cancel();
        }
      });
    },
  );
});
