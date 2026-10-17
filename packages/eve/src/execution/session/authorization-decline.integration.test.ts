import { defineWorkflowTool } from "#tools/workflow-definition.js";
import { delegateWeatherWorkflow } from "#internal/testing/workflow-tool-fixtures.js";
import { MockLanguageModelV4 } from "ai/test";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineDynamic } from "#dynamic/definition.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resumeHook } from "#internal/workflow/runtime.js";
import { filterEventsByType } from "#internal/testing/events.js";
import { captureEvents, buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { workflowEntry } from "#execution/session/entry.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import {
  createWeatherAuthRuntime,
  authorizationAttemptId,
  userAuth,
} from "./authorization-test-helpers.js";

afterEach(() => vi.unstubAllGlobals());

describe("inline sign-in decline", () => {
  it.each([1, 2])("declines an inline sign-in with %i pending attempts", async (count) => {
    const modelRequests: string[] = [];
    let calls = 0;
    const model = markMockModel(
      new MockLanguageModelV4({
        doStream: async (options) => {
          modelRequests.push(JSON.stringify(options));
          if (calls++ > 0) return textStreamResult("Continuing without signing in.");
          return toolCallsStreamResult(
            (count === 1 ? ["weather"] : ["weather", "forecast"]).map((name) => ({
              input: JSON.stringify({ city: "Lisbon" }),
              toolCallId: `call-${name}`,
              toolName: `get_${name}`,
            })),
          );
        },
      }),
    );
    const { runtime, completeCalls, executions } = await createWeatherAuthRuntime(
      `decline-inline-${count}`,
      [],
      {
        definition: defineAgent({
          model: defineDynamic({
            events: { "step.started": () => ({ model, modelContextWindowTokens: 200000 }) },
          }),
        }),
        forecastConnection: count === 1 ? undefined : "forecast",
      },
    );
    const continuationToken = `http:decline-inline-${count}`;
    await runtime.run(async () => {
      const run = await startSessionOwner(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: {
            message:
              count === 1
                ? "Use the get_weather tool to check the weather in Lisbon."
                : "Call tools in parallel: get_weather, get_forecast",
          },
          serializedContext: buildSerializedContext({
            auth: userAuth("user-1"),
            channelKind: "http",
            continuationToken,
          }),
        },
      ]);
      const stream = captureEvents(run);
      try {
        const held = await stream.nextUntil(
          "sign-in hold",
          (event) => event.type === "turn.waiting",
        );
        const required = filterEventsByType(held, "authorization.required");
        expect(required).toHaveLength(count);
        await resumeHook(sessionInboxHookToken(continuationToken), {
          kind: "send",
          payload: { authorizationDecline: { attemptId: "stale-attempt" } },
        });
        for (const [index, challenge] of required.entries()) {
          const before = modelRequests.length;
          const attemptId = authorizationAttemptId([challenge]);
          await resumeHook(sessionInboxHookToken(continuationToken), {
            kind: "send",
            auth: userAuth("other-person"),
            payload: { authorizationDecline: { attemptId } },
          });
          const last = index === count - 1;
          const resumed = await stream.nextUntil(
            "decline settled",
            (event) => event.type === (last ? "session.waiting" : "turn.waiting"),
          );
          expect(filterEventsByType(resumed, "authorization.completed")).toMatchObject([
            {
              data: { attemptId, outcome: "declined", name: challenge.data.name },
            },
          ]);
          const completion = filterEventsByType(resumed, "authorization.completed")[0]!;
          expect(completion.data.turnId).toBe(challenge.data.turnId);
          expect(completion.data.stepIndex).toBe(challenge.data.stepIndex);
          expect(completeCalls()).toBe(0);
          // The call that waited for the sign-in fails with why, and never runs.
          expect(filterEventsByType(resumed, "action.result")).toMatchObject([
            { data: { result: { isError: true, output: "The user declined to sign in." } } },
          ]);
          expect(executions()).toEqual([]);
          if (!last) expect(modelRequests).toHaveLength(before);
          else {
            expect(resumed.some((event) => event.type === "turn.completed")).toBe(true);
            for (const original of required) {
              expect(modelRequests.slice(before).join("\n")).toContain(
                `The user declined to sign in to ${original.data.name}. Continue without it`,
              );
            }
            expect(modelRequests.slice(before).join("\n")).toContain(
              `The user declined to sign in to ${challenge.data.name}. Continue without it`,
            );
          }
        }
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });
});

describe("subagent sign-in decline", () => {
  it("routes a decline to the child and relays its settlement while the parent continues", async () => {
    const requests: string[] = [];
    const model = markMockModel(
      new MockLanguageModelV4({
        doStream: async (options) => {
          const prompt = JSON.stringify(options.prompt);
          requests.push(prompt);
          if (prompt.includes("The user declined to sign in"))
            return textStreamResult("Continuing without signing in.");
          if (prompt.includes("Continuing without signing in."))
            return textStreamResult("Parent continued.");
          const child = prompt.includes("Check Lisbon using get_weather.");
          return toolCallsStreamResult([
            {
              input: JSON.stringify(child ? { city: "Lisbon" } : { service: "weather" }),
              toolCallId: child ? "child-weather" : "parent-delegate",
              toolName: child ? "get_weather" : "delegate_weather",
            },
          ]);
        },
      }),
    );
    const { runtime, completeCalls } = await createWeatherAuthRuntime(
      "decline-child",
      [
        {
          logicalPath: "tools/delegate_weather.ts",
          loadNamespace: async () => ({
            default: defineWorkflowTool({
              description: "Ask a child to check weather.",
              inputSchema: {
                type: "object",
                properties: { service: { type: "string" } },
                required: ["service"],
              },
              execute: delegateWeatherWorkflow,
            }),
          }),
        },
      ],
      {
        definition: defineAgent({
          model: defineDynamic({
            events: { "step.started": () => ({ model, modelContextWindowTokens: 200000 }) },
          }),
        }),
      },
    );
    const continuationToken = "http:decline-child";
    await runtime.run(async () => {
      const run = await startSessionOwner(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "Use delegate_weather to check weather through a child." },
          serializedContext: {
            ...buildSerializedContext({
              auth: userAuth("user-1"),
              channelKind: "http",
              continuationToken,
            }),
            "eve.capabilities": { requestInput: true },
          },
        },
      ]);
      const stream = captureEvents(run);
      try {
        const events = await stream.nextUntil(
          "child sign-in",
          (event) => event.type === "authorization.required",
        );
        const required = filterEventsByType(events, "authorization.required")[0]!;
        await resumeHook(sessionInboxHookToken(continuationToken), {
          kind: "send",
          payload: { authorizationDecline: { attemptId: required.data.attemptId! } },
        });
        events.push(
          ...(await stream.nextUntil(
            "parent continued",
            (event) => event.type === "session.waiting",
          )),
        );
        expect(filterEventsByType(events, "authorization.completed")).toMatchObject([
          {
            data: {
              attemptId: required.data.attemptId,
              outcome: "declined",
              turnId: required.data.turnId,
            },
          },
        ]);
        expect(filterEventsByType(events, "turn.completed")).toHaveLength(1);
        expect(JSON.stringify(events)).toContain("Parent continued.");
        expect(requests.join("\n")).toContain("The user declined to sign in to weather.");
        expect(completeCalls()).toBe(0);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60000);
});
