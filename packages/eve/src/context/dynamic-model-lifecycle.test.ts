import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { ContextContainer } from "#context/container.js";
import {
  dispatchDynamicModelEvent,
  getActiveDynamicModelSelection,
  refreshDynamicSessionModelForRuntimeRevision,
} from "#context/dynamic-model-lifecycle.js";
import {
  LiveStepDynamicModelSelectionKey,
  SessionDynamicModelReferenceKey,
  SessionDynamicModelRuntimeRevisionKey,
  TurnDynamicModelReferenceKey,
} from "#context/keys.js";
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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("dynamic model lifecycle", () => {
  it("persists session-scoped model references", async () => {
    const ctx = new ContextContainer();
    const moduleMap = createModuleMap({
      default: {
        model: defineDynamic({
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
      messages: [],
      scope: { moduleMap, nodeId: undefined },
    });

    expect(getActiveDynamicModelSelection(ctx)).toEqual({
      reference: {
        contextWindowTokens: 128_000,
        id: "openai/gpt-5.5-mini",
        maxOutputTokens: undefined,
        providerOptions: undefined,
      },
    });
  });

  it("prefers step, then turn, then session selections", () => {
    const ctx = new ContextContainer();
    ctx.set(SessionDynamicModelReferenceKey, {
      contextWindowTokens: 100_000,
      id: "openai/session",
    });
    ctx.set(TurnDynamicModelReferenceKey, {
      contextWindowTokens: 100_000,
      id: "openai/turn",
    });

    expect(getActiveDynamicModelSelection(ctx)?.reference.id).toBe("openai/turn");

    ctx.setVirtualContext(LiveStepDynamicModelSelectionKey, {
      reference: { contextWindowTokens: 100_000, id: "openai/step" },
    });
    expect(getActiveDynamicModelSelection(ctx)?.reference.id).toBe("openai/step");
  });

  it("clears narrower scopes at their lifecycle boundary without a matching handler", async () => {
    const ctx = new ContextContainer();
    ctx.set(SessionDynamicModelReferenceKey, {
      contextWindowTokens: 100_000,
      id: "openai/session",
    });
    ctx.set(TurnDynamicModelReferenceKey, {
      contextWindowTokens: 100_000,
      id: "openai/previous-turn",
    });
    ctx.setVirtualContext(LiveStepDynamicModelSelectionKey, {
      reference: { contextWindowTokens: 100_000, id: "openai/previous-step" },
    });
    const dynamicModel = { ...DYNAMIC_MODEL_SOURCE, eventNames: ["session.started"] };
    const scope = { moduleMap: createModuleMap({}), nodeId: undefined };

    await dispatchDynamicModelEvent({
      ctx,
      dynamicModel,
      event: createTurnStartedEvent({ sequence: 1, turnId: "turn_1" }),
      messages: [],
      scope,
    });
    await dispatchDynamicModelEvent({
      ctx,
      dynamicModel,
      event: createStepStartedEvent({
        modelId: "openai/session",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      messages: [],
      scope,
    });

    expect(ctx.get(TurnDynamicModelReferenceKey)).toBeNull();
    expect(ctx.get(LiveStepDynamicModelSelectionKey)).toBeNull();
    expect(getActiveDynamicModelSelection(ctx)?.reference.id).toBe("openai/session");
  });

  it("replaces turn-scoped selections on each matching turn", async () => {
    const ctx = new ContextContainer();
    let turnModel = "openai/first-turn";
    const moduleMap = createModuleMap({
      default: {
        model: defineDynamic({
          events: {
            "turn.started": () => ({
              model: turnModel,
              modelContextWindowTokens: 100_000,
            }),
          },
        }),
      },
    });

    const dispatch = (sequence: number) =>
      dispatchDynamicModelEvent({
        ctx,
        dynamicModel: DYNAMIC_MODEL_SOURCE,
        event: createTurnStartedEvent({ sequence, turnId: `turn_${sequence}` }),
        messages: [],
        scope: { moduleMap, nodeId: undefined },
      });

    await dispatch(0);
    expect(getActiveDynamicModelSelection(ctx)?.reference.id).toBe("openai/first-turn");

    turnModel = "openai/second-turn";
    await dispatch(1);
    expect(getActiveDynamicModelSelection(ctx)?.reference.id).toBe("openai/second-turn");
  });

  it("refreshes a session-scoped selection once per runtime revision", async () => {
    const ctx = new ContextContainer();
    let model = "openai/first-deployment";
    const handler = vi.fn(() => ({
      model,
      modelContextWindowTokens: 100_000,
    }));
    const moduleMap = createModuleMap({
      default: {
        model: defineDynamic({
          events: { "session.started": handler },
        }),
      },
    });
    const refresh = (runtimeRevision: string) =>
      refreshDynamicSessionModelForRuntimeRevision({
        ctx,
        dynamicModel: DYNAMIC_MODEL_SOURCE,
        event: createSessionStartedEvent(),
        messages: [],
        runtimeRevision,
        scope: { moduleMap, nodeId: undefined },
      });

    await refresh("deployment:one");
    await refresh("deployment:one");

    expect(handler).toHaveBeenCalledOnce();
    expect(getActiveDynamicModelSelection(ctx)?.reference.id).toBe("openai/first-deployment");

    model = "openai/second-deployment";
    await refresh("deployment:two");

    expect(handler).toHaveBeenCalledTimes(2);
    expect(ctx.get(SessionDynamicModelRuntimeRevisionKey)).toBe("deployment:two");
    expect(getActiveDynamicModelSelection(ctx)?.reference.id).toBe("openai/second-deployment");
  });

  it("clears a stale session selection when the current runtime has no session resolver", async () => {
    const ctx = new ContextContainer();
    ctx.set(SessionDynamicModelReferenceKey, {
      contextWindowTokens: 100_000,
      id: "openai/stale",
    });

    await refreshDynamicSessionModelForRuntimeRevision({
      ctx,
      dynamicModel: { ...DYNAMIC_MODEL_SOURCE, eventNames: ["turn.started"] },
      event: createSessionStartedEvent(),
      messages: [],
      runtimeRevision: "deployment:new",
      scope: { moduleMap: createModuleMap({}), nodeId: undefined },
    });

    expect(ctx.get(SessionDynamicModelReferenceKey)).toBeNull();
    expect(ctx.get(SessionDynamicModelRuntimeRevisionKey)).toBe("deployment:new");
    expect(getActiveDynamicModelSelection(ctx)).toBeNull();
  });

  it("keeps step-scoped live provider instances outside mock mode", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const ctx = new ContextContainer();
    const stepModel = createLanguageModel("openai.responses", "gpt-step");
    const moduleMap = createModuleMap({
      default: {
        model: defineDynamic({
          events: {
            "step.started": () => ({
              model: stepModel,
              modelContextWindowTokens: 64_000,
            }),
          },
        }),
      },
    });

    await dispatchDynamicModelEvent({
      ctx,
      dynamicModel: DYNAMIC_MODEL_SOURCE,
      event: createStepStartedEvent({
        modelId: "unresolved",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
      }),
      messages: [{ content: "Use the direct model.", role: "user" }],
      scope: { moduleMap, nodeId: undefined },
    });

    expect(getActiveDynamicModelSelection(ctx)).toEqual({
      model: stepModel,
      reference: {
        contextWindowTokens: 64_000,
        id: "openai/gpt-step",
        maxOutputTokens: undefined,
        providerOptions: undefined,
      },
    });
  });

  it("strips step-scoped live provider instances in mock mode", async () => {
    const ctx = new ContextContainer();
    const stepModel = createLanguageModel("openai.responses", "gpt-step");
    const moduleMap = createModuleMap({
      default: {
        model: defineDynamic({
          events: {
            "step.started": () => ({
              model: stepModel,
              modelContextWindowTokens: 64_000,
            }),
          },
        }),
      },
    });

    await dispatchDynamicModelEvent({
      ctx,
      dynamicModel: DYNAMIC_MODEL_SOURCE,
      event: createStepStartedEvent({
        modelId: "unresolved",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
      }),
      messages: [],
      scope: { moduleMap, nodeId: undefined },
    });

    expect(getActiveDynamicModelSelection(ctx)).toEqual({
      reference: {
        contextWindowTokens: 64_000,
        id: "openai/gpt-step",
        maxOutputTokens: undefined,
        providerOptions: undefined,
      },
    });
  });

  it("rejects live provider instances at durable scopes", async () => {
    const ctx = new ContextContainer();
    const liveModel = createLanguageModel("openai.responses", "gpt-live");
    const moduleMap = createModuleMap({
      default: {
        model: defineDynamic({
          events: {
            "session.started": () => ({
              model: liveModel,
              modelContextWindowTokens: 64_000,
            }),
          },
        }),
      },
    });

    await expect(
      dispatchDynamicModelEvent({
        ctx,
        dynamicModel: DYNAMIC_MODEL_SOURCE,
        event: createSessionStartedEvent(),
        messages: [],
        scope: { moduleMap, nodeId: undefined },
      }),
    ).rejects.toThrow(/must be serializable/);

    expect(ctx.get(SessionDynamicModelReferenceKey)).toBeNull();
  });

  it("propagates resolver exceptions without selecting a fallback", async () => {
    const ctx = new ContextContainer();
    ctx.set(TurnDynamicModelReferenceKey, {
      contextWindowTokens: 100_000,
      id: "openai/previous-turn",
    });
    const moduleMap = createModuleMap({
      default: {
        model: defineDynamic({
          events: {
            "turn.started": () => {
              throw new Error("flag service unavailable");
            },
          },
        }),
      },
    });

    await expect(
      dispatchDynamicModelEvent({
        ctx,
        dynamicModel: DYNAMIC_MODEL_SOURCE,
        event: createTurnStartedEvent({ sequence: 0, turnId: "turn_0" }),
        messages: [],
        scope: { moduleMap, nodeId: undefined },
      }),
    ).rejects.toThrow("flag service unavailable");

    expect(ctx.get(TurnDynamicModelReferenceKey)).toBeNull();
    expect(getActiveDynamicModelSelection(ctx)).toBeNull();
  });

  it("rejects null and malformed selections", async () => {
    const ctx = new ContextContainer();
    let result: unknown = null;
    const moduleMap = createModuleMap({
      default: {
        model: defineDynamic({
          events: {
            "session.started": () => result as never,
          },
        }),
      },
    });
    const dispatch = () =>
      dispatchDynamicModelEvent({
        ctx,
        dynamicModel: DYNAMIC_MODEL_SOURCE,
        event: createSessionStartedEvent(),
        messages: [],
        scope: { moduleMap, nodeId: undefined },
      });

    await expect(dispatch()).rejects.toThrow(/returned no model/);
    expect(ctx.get(SessionDynamicModelReferenceKey)).toBeNull();

    result = {
      contextWindowTokens: 128_000,
      model: "openai/gpt-5.5-mini",
    };
    await expect(dispatch()).rejects.toThrow(/unknown key\(s\): contextWindowTokens/);
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
