import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { ContextContainer } from "#context/container.js";
import { dispatchDynamicModelEvent } from "#context/dynamic-model-lifecycle.js";
import { getEffectiveModelSelection } from "#context/effective-model.js";
import {
  StaticModelReferenceKey,
  LiveStepDynamicModelSelectionKey,
  SessionDynamicModelReferenceKey,
  TurnDynamicModelReferenceKey,
} from "#context/keys.js";
import { defineDynamic } from "#public/definitions/tool.js";
import {
  createSessionStartedEvent,
  createStepStartedEvent,
  createTurnStartedEvent,
} from "#protocol/message.js";
import type { RuntimeDynamicModelReference } from "#runtime/agent/bootstrap.js";

const FALLBACK = { id: "openai/gpt-5.5" } as const;

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
    const ctx = createCtx();
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

    expect(getEffectiveModelSelection(ctx)).toEqual({
      reference: {
        contextWindowTokens: 128_000,
        id: "openai/gpt-5.5-mini",
        maxOutputTokens: undefined,
        providerOptions: undefined,
      },
    });
    expect(ctx.get(StaticModelReferenceKey)?.id).toBe(FALLBACK.id);
  });

  it("prefers step, then turn, then session selections", () => {
    const ctx = createCtx();
    ctx.set(SessionDynamicModelReferenceKey, {
      contextWindowTokens: 100_000,
      id: "openai/session",
    });
    ctx.set(TurnDynamicModelReferenceKey, {
      contextWindowTokens: 100_000,
      id: "openai/turn",
    });

    expect(getEffectiveModelSelection(ctx)?.reference.id).toBe("openai/turn");

    ctx.setVirtualContext(LiveStepDynamicModelSelectionKey, {
      reference: { contextWindowTokens: 100_000, id: "openai/step" },
    });
    expect(getEffectiveModelSelection(ctx)?.reference.id).toBe("openai/step");
  });

  it("exposes the lower-precedence model to a resolver", async () => {
    const ctx = createCtx();
    ctx.set(SessionDynamicModelReferenceKey, { id: "openai/session" });
    ctx.set(TurnDynamicModelReferenceKey, { id: "openai/previous-turn" });
    const observed: Array<string | undefined> = [];
    const moduleMap = createModuleMap({
      default: {
        model: defineDynamic({
          events: {
            "turn.started": (_event, resolveCtx) => {
              observed.push(resolveCtx.model?.id);
              return {
                model: "openai/next-turn",
                modelContextWindowTokens: 100_000,
              };
            },
          },
        }),
      },
    });

    await dispatchDynamicModelEvent({
      ctx,
      dynamicModel: DYNAMIC_MODEL_SOURCE,
      event: createTurnStartedEvent({ sequence: 0, turnId: "turn_0" }),
      messages: [],
      scope: { moduleMap, nodeId: undefined },
    });

    expect(observed).toEqual(["openai/session"]);
  });

  it("replaces turn-scoped selections on each matching turn", async () => {
    const ctx = createCtx();
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
    expect(getEffectiveModelSelection(ctx)?.reference.id).toBe("openai/first-turn");

    turnModel = "openai/second-turn";
    await dispatch(1);
    expect(getEffectiveModelSelection(ctx)?.reference.id).toBe("openai/second-turn");
  });

  it("keeps step-scoped live provider instances outside mock mode", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const ctx = createCtx();
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

    expect(getEffectiveModelSelection(ctx)).toEqual({
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
    const ctx = createCtx();
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

    expect(getEffectiveModelSelection(ctx)).toEqual({
      reference: {
        contextWindowTokens: 64_000,
        id: "openai/gpt-step",
        maxOutputTokens: undefined,
        providerOptions: undefined,
      },
    });
  });

  it("rejects live provider instances at durable scopes", async () => {
    const ctx = createCtx();
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
    const ctx = createCtx();
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
    expect(getEffectiveModelSelection(ctx)?.reference).toEqual(FALLBACK);
  });

  it("rejects null and malformed selections", async () => {
    const ctx = createCtx();
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

function createCtx(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(StaticModelReferenceKey, FALLBACK);
  return ctx;
}

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
