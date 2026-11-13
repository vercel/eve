import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";

import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import type { ProgrammaticAgentModule } from "#compiler/source-graph.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import {
  finalizeInstrumentationProviders,
  registerInstrumentationProvider,
  shutdownInstrumentationProviders,
} from "#instrumentation/providers.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { buildSerializedContext, withTimeout } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { resumeRoutedHook } from "#execution/hosts.js";
import { startTestSession } from "#internal/testing/test-session-hosts.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineHook } from "#public/definitions/hook.js";
import { defineDynamic as defineDynamicModel } from "#public/definitions/model.js";
import { defineState } from "#public/definitions/state.js";
import { otelIntegration } from "#tracing/eve/otel-declaration.js";
import { defineTool } from "#tools/definition.js";

// A turn.started hook can decide something for the turn, such as which model it runs or a
// feature flag, and keep it in state. These pin that the turn's own readers see that decision.

type Choice = "first" | "second";

const REGISTRY_GLOBAL_KEY = Symbol.for("eve.harness-instrumentation-providers");
const RUNTIME_GLOBAL_KEY = Symbol.for("eve.instrumentation-runtime");

const choice = defineState<Choice>("test.turn-choice", () => "first");

function caller(plan: string) {
  return {
    attributes: { plan },
    authenticator: "test",
    issuer: "test",
    principalId: "alice",
    principalType: "user" as const,
  };
}

/** Each turn calls `lookup` once and then replies, so it makes two model calls. */
function scriptedModel(name: Choice, served: Choice[]) {
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }: { prompt: LanguageModelV4Prompt }) => {
        served.push(name);
        return prompt.at(-1)?.role === "tool"
          ? textStreamResult("Done.")
          : toolCallStreamResult({
              input: "{}",
              toolCallId: `call-${served.length}`,
              toolName: "lookup",
            });
      },
      modelId: name,
      provider: "eve-test",
    }),
  );
}

/**
 * Two turns of two model calls each. The hook picks the second model for a turn that asks for
 * it, after a pause like a remote lookup's; the dynamic model runs what the hook picked.
 */
async function runTwoTurns(): Promise<readonly Choice[]> {
  const served: Choice[] = [];
  const models = { first: scriptedModel("first", served), second: scriptedModel("second", served) };
  const modules: ProgrammaticAgentModule[] = [
    {
      loadNamespace: async () => ({
        default: defineHook({
          events: {
            "turn.started": async (_event, ctx) => {
              await new Promise((resolve) => setTimeout(resolve, 50));
              const asksForSecond = JSON.stringify(ctx.turn?.input).includes("second");
              choice.update(() => (asksForSecond ? "second" : "first"));
            },
          },
        }),
      }),
      logicalPath: "hooks/choose.ts",
    },
    {
      loadNamespace: async () => ({
        default: defineTool({
          description: "Look something up.",
          execute: async () => ({ found: true }),
          inputSchema: {},
        }),
      }),
      logicalPath: "tools/lookup.ts",
    },
  ];
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamicModel(() => ({
          model: models[choice.get()],
          modelContextWindowTokens: 200_000,
        })),
      }),
      name: "hook-state",
    },
    modules,
  });
  const continuationToken = "http:hook-state";

  await runtime.run(async () => {
    const run = await startTestSession("in-process", {
      kind: "initial",
      ownerDeploymentId: "dpl_inline",
      input: { message: "Use the first model." },
      serializedContext: buildSerializedContext({
        auth: caller("pro"),
        channelKind: "http",
        continuationToken,
      }),
    });
    const stream = captureTurnEvents(run);
    try {
      // The second message must start its own turn, not steer the first one.
      await withTimeout(stream.nextTurn(), "first turn");
      await resumeRoutedHook(sessionInboxHookToken(continuationToken), {
        auth: caller("team"),
        delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
        kind: "send",
        payload: { message: "Use the second model." },
      });
      await withTimeout(stream.nextTurn(), "second turn");
    } finally {
      stream.dispose();
      await run.cancel().catch(() => {});
    }
  });
  return served;
}

describe("state a turn.started hook writes", () => {
  afterEach(async () => {
    await shutdownInstrumentationProviders();
    delete (globalThis as Record<symbol, unknown>)[REGISTRY_GLOBAL_KEY];
    delete (globalThis as Record<symbol, unknown>)[RUNTIME_GLOBAL_KEY];
  });

  it("chooses the model for every call of that turn, starting with the first", async () => {
    expect(await runTwoTurns()).toEqual(["first", "first", "second", "second"]);
  }, 60_000);

  it("reaches each call's telemetry runtime context, beside the turn's caller", async () => {
    const reported: { readonly choice: Choice; readonly plan: unknown }[] = [];
    await registerInstrumentationProvider({
      agentName: "hook-state",
      slot: "otel",
      value: otelIntegration({
        runtimeContext(input) {
          const plan = input.session.auth.current?.attributes.plan;
          reported.push({ choice: choice.get(), plan });
          return { choice: choice.get() };
        },
      }),
    });
    finalizeInstrumentationProviders({ serviceName: "hook-state" });

    const served = await runTwoTurns();

    expect(reported.map((entry) => entry.choice)).toEqual(served);
    expect(reported).toEqual([
      { choice: "first", plan: "pro" },
      { choice: "first", plan: "pro" },
      { choice: "second", plan: "team" },
      { choice: "second", plan: "team" },
    ]);
  }, 60_000);
});
