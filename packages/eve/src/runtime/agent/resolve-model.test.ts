import { describe, expect, it } from "vitest";

import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { defineDynamic } from "#public/definitions/tool.js";
import {
  loadDynamicRuntimeModelDefinition,
  normalizeDynamicRuntimeModelResult,
} from "#runtime/agent/resolve-model.js";

const DYNAMIC_MODEL_SOURCE = {
  eventNames: ["session.started"],
  logicalPath: "agent.ts",
  sourceId: "agent-config",
  sourceKind: "module" as const,
};

describe("dynamic runtime model resolution", () => {
  it("loads dynamic model definitions and normalizes string selections", async () => {
    const moduleMap = createModuleMap({
      default: {
        model: defineDynamic({
          fallback: "openai/gpt-5.5",
          events: {
            "session.started": (_event, ctx) =>
              ctx.channel.kind === "slack"
                ? {
                    model: "openai/gpt-5.5-mini",
                    modelContextWindowTokens: 128_000,
                    modelOptions: {
                      providerOptions: { gateway: { order: ["openai"] } },
                    },
                  }
                : null,
          },
        }),
      },
    });

    const definition = await loadDynamicRuntimeModelDefinition({
      dynamicModel: DYNAMIC_MODEL_SOURCE,
      scope: { moduleMap, nodeId: undefined },
    });
    const result = await definition.events["session.started"]?.(
      { type: "session.started" },
      {
        channel: { kind: "slack" },
        messages: [{ content: "Hi", role: "user" }],
        session: { auth: { current: null, initiator: null }, id: "session-1" },
      },
    );

    expect(result).not.toBeNull();
    if (result === null || result === undefined) throw new Error("expected selection");

    const resolved = normalizeDynamicRuntimeModelResult({
      fallback: { contextWindowTokens: 256_000, id: "openai/gpt-5.5" },
      result,
    });

    expect(resolved).toEqual({
      reference: {
        contextWindowTokens: 128_000,
        id: "openai/gpt-5.5-mini",
        providerOptions: { gateway: { order: ["openai"] } },
      },
    });
  });

  it("inherits fallback provider options but never the fallback context window", () => {
    const resolved = normalizeDynamicRuntimeModelResult({
      fallback: {
        contextWindowTokens: 256_000,
        id: "openai/gpt-5.5",
        providerOptions: { gateway: { order: ["openai"] } },
      },
      result: "openai/gpt-5.5-mini",
    });

    expect(resolved.reference).toEqual({
      contextWindowTokens: undefined,
      id: "openai/gpt-5.5-mini",
      providerOptions: { gateway: { order: ["openai"] } },
    });
  });

  it("rejects selections with unknown keys", () => {
    expect(() =>
      normalizeDynamicRuntimeModelResult({
        fallback: { id: "openai/gpt-5.5" },
        result: {
          model: "openai/gpt-5.5-mini",
          contextWindowTokens: 128_000,
        } as never,
      }),
    ).toThrowError(/unknown key\(s\): contextWindowTokens/);
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
