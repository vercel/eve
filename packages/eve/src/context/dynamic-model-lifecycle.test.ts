import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { ContextContainer } from "#context/container.js";
import {
  dispatchDynamicModelEvent,
  getActiveDynamicModelSelection,
} from "#context/dynamic-model-lifecycle.js";
import { SessionDynamicModelReferenceKey, TurnDynamicModelReferenceKey } from "#context/keys.js";
import { defineDynamic } from "#public/definitions/tool.js";
import {
  createSessionStartedEvent,
  createStepStartedEvent,
  createTurnStartedEvent,
} from "#protocol/message.js";
import type { RuntimeDynamicModelReference } from "#runtime/agent/bootstrap.js";

const DYNAMIC_MODEL_SOURCE: RuntimeDynamicModelReference = {
  eventNames: ["session.started", "turn.started", "step.started"],
  logicalPath: "agent.ts",
  sourceId: "agent-config",
  sourceKind: "module",
};

const FALLBACK = { contextWindowTokens: 256_000, id: "openai/gpt-5.5" };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("dynamic model lifecycle", () => {
  it("persists session-scoped model references", async () => {
    const ctx = new ContextContainer();
    const moduleMap = createModuleMap({
      default: {
        model: defineDynamic({
          fallback: "openai/gpt-5.5",
          events: {
            "session.started": () => ({
              model: "openai/gpt-5.5-mini",
              modelContextWindowTokens: 128_000,
            }),
          },
        }),
      },
    });

    await dispatchDynamicModelEvent({
      ctx,
      dynamicModel: DYNAMIC_MODEL_SOURCE,
      event: createSessionStartedEvent(),
      fallback: FALLBACK,
      messages: [],
      scope: { moduleMap, nodeId: undefined },
    });

    expect(getActiveDynamicModelSelection(ctx)).toEqual({
      reference: {
        contextWindowTokens: 128_000,
        id: "openai/gpt-5.5-mini",
        providerOptions: undefined,
      },
    });
  });

  it("does not inherit the fallback context window for a different model", async () => {
    const ctx = new ContextContainer();
    const moduleMap = createModuleMap({
      default: {
        model: defineDynamic({
          fallback: "openai/gpt-5.5",
          events: {
            "session.started": () => "openai/gpt-5.5-mini",
          },
        }),
      },
    });

    await dispatchDynamicModelEvent({
      ctx,
      dynamicModel: DYNAMIC_MODEL_SOURCE,
      event: createSessionStartedEvent(),
      fallback: FALLBACK,
      messages: [],
      scope: { moduleMap, nodeId: undefined },
    });

    expect(getActiveDynamicModelSelection(ctx)?.reference.contextWindowTokens).toBeUndefined();
  });

  it("lets turn-scoped selections override session selections and null fall back", async () => {
    const ctx = new ContextContainer();
    let turnResult: string | null = "openai/gpt-5.5-turn";
    const moduleMap = createModuleMap({
      default: {
        model: defineDynamic({
          fallback: "openai/gpt-5.5",
          events: {
            "session.started": () => "openai/gpt-5.5-mini",
            "turn.started": () => turnResult,
          },
        }),
      },
    });
    const dispatch = (event: Parameters<typeof dispatchDynamicModelEvent>[0]["event"]) =>
      dispatchDynamicModelEvent({
        ctx,
        dynamicModel: DYNAMIC_MODEL_SOURCE,
        event,
        fallback: FALLBACK,
        messages: [],
        scope: { moduleMap, nodeId: undefined },
      });

    await dispatch(createSessionStartedEvent());
    await dispatch(createTurnStartedEvent({ sequence: 0, turnId: "turn_0" }));

    expect(getActiveDynamicModelSelection(ctx)?.reference.id).toBe("openai/gpt-5.5-turn");

    turnResult = null;
    await dispatch(createTurnStartedEvent({ sequence: 1, turnId: "turn_1" }));

    expect(getActiveDynamicModelSelection(ctx)?.reference.id).toBe("openai/gpt-5.5-mini");
  });

  it("keeps step-scoped live provider instances outside mock mode", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const ctx = new ContextContainer();
    const stepModel = createLanguageModel("openai.responses", "gpt-step");
    const moduleMap = createModuleMap({
      default: {
        model: defineDynamic({
          fallback: "openai/gpt-5.5",
          events: {
            "session.started": () => "openai/gpt-5.5-mini",
            "step.started": () => stepModel,
          },
        }),
      },
    });

    await dispatchDynamicModelEvent({
      ctx,
      dynamicModel: DYNAMIC_MODEL_SOURCE,
      event: createSessionStartedEvent(),
      fallback: { id: "openai/gpt-5.5" },
      messages: [],
      scope: { moduleMap, nodeId: undefined },
    });
    await dispatchDynamicModelEvent({
      ctx,
      dynamicModel: DYNAMIC_MODEL_SOURCE,
      event: createStepStartedEvent({ sequence: 0, stepIndex: 0, turnId: "turn_0" }),
      fallback: { id: "openai/gpt-5.5" },
      messages: [{ content: "Use the direct model.", role: "user" }],
      scope: { moduleMap, nodeId: undefined },
    });

    expect(getActiveDynamicModelSelection(ctx)).toEqual({
      model: stepModel,
      reference: {
        contextWindowTokens: undefined,
        id: "openai/gpt-step",
        providerOptions: undefined,
      },
    });
  });

  it("strips step-scoped live provider instances in mock mode", async () => {
    // NODE_ENV=test (the vitest default) activates the mock adapter.
    const ctx = new ContextContainer();
    const stepModel = createLanguageModel("openai.responses", "gpt-step");
    const moduleMap = createModuleMap({
      default: {
        model: defineDynamic({
          fallback: "openai/gpt-5.5",
          events: {
            "step.started": () => stepModel,
          },
        }),
      },
    });

    await dispatchDynamicModelEvent({
      ctx,
      dynamicModel: DYNAMIC_MODEL_SOURCE,
      event: createStepStartedEvent({ sequence: 0, stepIndex: 0, turnId: "turn_0" }),
      fallback: { id: "openai/gpt-5.5" },
      messages: [],
      scope: { moduleMap, nodeId: undefined },
    });

    expect(getActiveDynamicModelSelection(ctx)).toEqual({
      reference: {
        contextWindowTokens: undefined,
        id: "openai/gpt-step",
        providerOptions: undefined,
      },
    });
  });

  it("rejects live provider instances at session and turn scope", async () => {
    const ctx = new ContextContainer();
    const liveModel = createLanguageModel("openai.responses", "gpt-live");
    const moduleMap = createModuleMap({
      default: {
        model: defineDynamic({
          fallback: "openai/gpt-5.5",
          events: {
            "session.started": () => liveModel,
          },
        }),
      },
    });

    await dispatchDynamicModelEvent({
      ctx,
      dynamicModel: DYNAMIC_MODEL_SOURCE,
      event: createSessionStartedEvent(),
      fallback: FALLBACK,
      messages: [],
      scope: { moduleMap, nodeId: undefined },
    });

    expect(ctx.get(SessionDynamicModelReferenceKey)).toBeNull();
    expect(getActiveDynamicModelSelection(ctx)).toBeNull();
  });

  it("clears the scope and falls back when a resolver throws", async () => {
    const ctx = new ContextContainer();
    ctx.set(TurnDynamicModelReferenceKey, { id: "openai/gpt-prior" });
    const moduleMap = createModuleMap({
      default: {
        model: defineDynamic({
          fallback: "openai/gpt-5.5",
          events: {
            "turn.started": () => {
              throw new Error("flag service unavailable");
            },
          },
        }),
      },
    });

    await dispatchDynamicModelEvent({
      ctx,
      dynamicModel: DYNAMIC_MODEL_SOURCE,
      event: createTurnStartedEvent({ sequence: 0, turnId: "turn_0" }),
      fallback: FALLBACK,
      messages: [],
      scope: { moduleMap, nodeId: undefined },
    });

    expect(ctx.get(TurnDynamicModelReferenceKey)).toBeNull();
    expect(getActiveDynamicModelSelection(ctx)).toBeNull();
  });

  it("clears the scope when a selection carries unknown keys", async () => {
    const ctx = new ContextContainer();
    const moduleMap = createModuleMap({
      default: {
        model: defineDynamic({
          fallback: "openai/gpt-5.5",
          events: {
            "session.started": () =>
              ({
                model: "openai/gpt-5.5-mini",
                contextWindowTokens: 128_000,
              }) as never,
          },
        }),
      },
    });

    await dispatchDynamicModelEvent({
      ctx,
      dynamicModel: DYNAMIC_MODEL_SOURCE,
      event: createSessionStartedEvent(),
      fallback: FALLBACK,
      messages: [],
      scope: { moduleMap, nodeId: undefined },
    });

    expect(getActiveDynamicModelSelection(ctx)).toBeNull();
  });
});

function createModuleMap(moduleNamespace: Record<string, unknown>): CompiledModuleMap {
  return {
    nodes: {
      [ROOT_COMPILED_AGENT_NODE_ID]: {
        modules: {
          [DYNAMIC_MODEL_SOURCE.sourceId]: moduleNamespace,
        },
      },
    },
  };
}

function createLanguageModel(provider: string, modelId: string): LanguageModel {
  return {
    specificationVersion: "v2",
    provider,
    modelId,
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("not implemented");
    },
    doStream: async () => {
      throw new Error("not implemented");
    },
  } as LanguageModel;
}
