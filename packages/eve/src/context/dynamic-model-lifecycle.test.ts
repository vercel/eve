import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";

import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { ContextContainer } from "#context/container.js";
import {
  dispatchDynamicModelEvent,
  getActiveDynamicModelSelection,
} from "#context/dynamic-model-lifecycle.js";
import { defineDynamic } from "#public/definitions/tool.js";
import { createSessionStartedEvent, createStepStartedEvent } from "#protocol/message.js";
import type { RuntimeDynamicModelReference } from "#runtime/agent/bootstrap.js";

const DYNAMIC_MODEL_SOURCE: RuntimeDynamicModelReference = {
  eventNames: ["session.started", "step.started"],
  logicalPath: "agent.ts",
  sourceId: "agent-config",
  sourceKind: "module",
};

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
      fallback: { contextWindowTokens: 256_000, id: "openai/gpt-5.5" },
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

  it("lets step-scoped selections override session selections", async () => {
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
