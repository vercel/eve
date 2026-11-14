// Alice's deploy agent, for the in-process crash scenario. Its scripted model calls `deploy`, then
// replies with what it read: a result, or a note that a crash lost it or cut the call off. Each
// run of `deploy` goes to `<dir>/ran.log` and each prompt to `<dir>/prompts.log`, so what two
// processes did can be compared.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";

import { defineDynamic } from "#dynamic/definition.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { defineAgent } from "#public/definitions/agent.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";

import type { SessionStreamEvent } from "#protocol/session-event.js";

export const CRASH_AGENT_NAME = "crash-deploy";
export const ALICE_ASKS = "Deploy the change.";

/** What the model answers once it read how `deploy` came out. */
function replyTo(prompt: string): string {
  if (prompt.includes("may or may not have taken effect"))
    return "The deploy may have run before the crash; I'll check it before I run it again.";
  if (prompt.includes("result was lost")) return "The deploy ran before the crash; it's live.";
  return "Deployed.";
}

export function crashAgent(
  dir: string,
  options: {
    /** `deploy` asks for approval first. */
    readonly approval?: boolean;
    /** Runs inside `deploy`, after it recorded its run. */
    readonly deploying?: () => void;
  } = {},
) {
  // Marked as a mock, so a compiled definition's model isn't swapped for the test default.
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const seen = JSON.stringify(prompt);
        appendFileSync(join(dir, "prompts.log"), `${seen}\n`);
        return prompt.some((message) => message.role === "tool") ||
          seen.includes("may or may not have taken effect") ||
          seen.includes("result was lost")
          ? textStreamResult(replyTo(seen))
          : toolCallsStreamResult([{ input: "{}", toolCallId: "call-deploy", toolName: "deploy" }]);
      },
      modelId: CRASH_AGENT_NAME,
      provider: "eve-test",
    }),
  );
  return {
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
      }),
      name: CRASH_AGENT_NAME,
    },
    modules: [
      {
        loadNamespace: async () => ({
          default: defineTool({
            ...(options.approval === true && { approval: always() }),
            description: "Deploy Alice's change.",
            execute: async () => {
              appendFileSync(join(dir, "ran.log"), "deploy\n");
              options.deploying?.();
              return { deployed: true };
            },
            inputSchema: {},
          }),
        }),
        logicalPath: "tools/deploy.ts",
      },
    ],
  };
}

/** Each event's type, with how a call or turn came out: what the two hosts must agree on. */
export function crashShape(events: readonly Pick<SessionStreamEvent, "data" | "type">[]): string[] {
  return events.map(({ data, type }) => {
    const outcome = typeof data === "object" && data !== null && "outcome" in data && data.outcome;
    return typeof outcome === "string" ? `${type}:${outcome}` : type;
  });
}

/**
 * What Workflow streams for Alice's turn when the step that ran `deploy` loses its completion
 * once and is retried (`crash-parity.integration.test.ts` checks it does). An in-process turn a
 * kill -9 cut off at the same point goes on to the same stream (`crash.scenario.test.ts`).
 */
export const RETRIED_TOOL_STEP_SHAPE: readonly string[] = [
  "session.started",
  "delivery.admitted",
  "turn.started",
  "delivery.consumed",
  "model.requested",
  "model.started",
  "call.requested",
  "call.started",
  "call.settled:completed",
  "model.settled:completed",
  "usage.recorded",
  "model.requested",
  "model.started",
  "content.delta",
  "content.completed",
  "model.settled:completed",
  "usage.recorded",
  "turn.settled:completed",
  "delivery.settled:handled",
];
