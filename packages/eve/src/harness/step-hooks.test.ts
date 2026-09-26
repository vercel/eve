import type { LanguageModel, ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { ContextContainer, contextStorage } from "#context/container.js";
import { ConversationIdKey } from "#context/keys.js";
import { buildStepHooks } from "#harness/step-hooks.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import type { HarnessSession } from "#harness/types.js";

const emissionState: HarnessEmissionState = {
  sequence: 0,
  sessionStarted: true,
  stepIndex: 0,
  turnId: "turn_0",
};

function createSession(): HarnessSession {
  return {
    agent: {
      modelReference: { id: "test-model" },
      system: "test",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:test",
    history: [],
    sessionId: "session-test",
  };
}

describe("buildStepHooks", () => {
  it("emits step.started from onStepStart, not prepareStep", async () => {
    const emit = vi.fn(async () => {});
    const hooks = buildStepHooks({
      cachePath: { kind: "none" },
      emit,
      emissionState,
      marker: undefined,
      session: createSession(),
    });
    const messages: ModelMessage[] = [{ content: "hello", role: "user" }];

    await hooks.prepareStep({
      messages,
      model: {} as never,
      instructions: undefined,
      initialInstructions: undefined,
      initialMessages: [],
      responseMessages: [],
      runtimeContext: {},
      toolsContext: {},
      experimental_sandbox: undefined,
      stepNumber: 0,
      steps: [],
    });
    expect(emit).not.toHaveBeenCalled();

    await Reflect.apply(hooks.onStepStart, null, [{ messages }]);

    expect(emit).toHaveBeenCalledWith(
      {
        data: { modelId: "test-model", sequence: 0, stepIndex: 0, turnId: "turn_0" },
        type: "step.started",
      },
      messages,
    );
  });

  it("sends the trace conversation ID to Gateway without changing direct-provider options", async () => {
    const session: HarnessSession = {
      ...createSession(),
      rootSessionId: "root-session",
      agent: {
        ...createSession().agent,
        modelReference: {
          id: "anthropic/claude-sonnet-4-5",
          providerOptions: { gateway: { order: ["bedrock"] }, openai: { store: false } },
        },
      },
    };
    const context = new ContextContainer();
    context.set(ConversationIdKey, "forwarded-conversation");
    const prepare = (
      model: LanguageModel,
      cachePath: Parameters<typeof buildStepHooks>[0]["cachePath"],
    ) =>
      buildStepHooks({ emissionState, marker: undefined, cachePath, session }).prepareStep({
        messages: [],
        model,
        instructions: undefined,
        initialInstructions: undefined,
        initialMessages: [],
        responseMessages: [],
        runtimeContext: {},
        toolsContext: {},
        experimental_sandbox: undefined,
        stepNumber: 0,
        steps: [],
      });

    await contextStorage.run(context, async () => {
      expect(
        (await prepare("anthropic/claude-sonnet-4-5", { kind: "gateway-auto" }))?.providerOptions,
      ).toEqual({
        gateway: { caching: "auto", order: ["bedrock"], sessionId: "forwarded-conversation" },
        openai: { store: false },
      });
      expect(
        (
          await prepare(
            new MockLanguageModelV3({
              modelId: "anthropic/claude-sonnet-4-5",
              provider: "gateway.language-model",
            }),
            { kind: "gateway-auto" },
          )
        )?.providerOptions,
      ).toEqual({
        gateway: { caching: "auto", order: ["bedrock"], sessionId: "forwarded-conversation" },
        openai: { store: false },
      });
      expect(
        (
          await prepare(
            new MockLanguageModelV3({
              modelId: "claude-sonnet-4-5",
              provider: "anthropic.messages",
            }),
            { kind: "none" },
          )
        )?.providerOptions,
      ).toEqual({
        gateway: { order: ["bedrock"] },
        openai: { store: false },
      });
    });
  });

  it("preserves an authored Gateway session ID", async () => {
    const hooks = buildStepHooks({
      cachePath: { kind: "none" },
      emissionState,
      marker: undefined,
      session: {
        ...createSession(),
        agent: {
          ...createSession().agent,
          modelReference: {
            id: "anthropic/claude-sonnet-4-5",
            providerOptions: { gateway: { sessionId: "authored-session" } },
          },
        },
      },
    });

    const prepared = await hooks.prepareStep({
      messages: [],
      model: "anthropic/claude-sonnet-4-5",
      instructions: undefined,
      initialInstructions: undefined,
      initialMessages: [],
      responseMessages: [],
      runtimeContext: {},
      toolsContext: {},
      experimental_sandbox: undefined,
      stepNumber: 0,
      steps: [],
    });
    expect(prepared?.providerOptions).toEqual({ gateway: { sessionId: "authored-session" } });
  });
});
