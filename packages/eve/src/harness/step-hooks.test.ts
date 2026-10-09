import type { LanguageModel, ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { ContextContainer, contextStorage } from "#context/container.js";
import { ConversationIdKey } from "#context/keys.js";
import { resolveModelProfile } from "#harness/model-profile.js";
import { buildStepHooks } from "#harness/step-hooks.js";
import type { HarnessSession } from "#harness/types.js";

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
  it("starts the step from onStepStart, not prepareStep", async () => {
    const startStep = vi.fn(async () => {});
    const hooks = buildStepHooks({
      profile: resolveModelProfile("openai/gpt-5"),
      session: createSession(),
      startStep,
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
    expect(startStep).not.toHaveBeenCalled();

    await Reflect.apply(hooks.onStepStart, null, [{ messages }]);

    expect(startStep).toHaveBeenCalledWith(messages);
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
    const prepare = (model: LanguageModel) =>
      buildStepHooks({ profile: resolveModelProfile(model), session }).prepareStep({
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
      expect((await prepare("anthropic/claude-sonnet-4-5"))?.providerOptions).toEqual({
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
      profile: resolveModelProfile("anthropic/claude-sonnet-4-5"),
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
    expect(prepared?.providerOptions).toEqual({
      gateway: { caching: "auto", sessionId: "authored-session" },
    });
  });
});
