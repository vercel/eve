import { describe, expect, it } from "vitest";

import { gatewayModelCapabilities } from "./model-capabilities.js";
import type { GatewayCatalogModel } from "./select-model.js";

function entry(overrides: Partial<GatewayCatalogModel> & { id: string }): GatewayCatalogModel {
  return {
    name: overrides.id,
    type: "language",
    owned_by: overrides.id.split("/")[0] ?? "",
    reasoningEfforts: [],
    ...overrides,
  };
}

const CATALOG: GatewayCatalogModel[] = [
  entry({
    id: "openai/gpt-5.5",
    tags: ["reasoning", "web-search"],
    reasoningEfforts: ["minimal", "high"],
    pricing: { service_tiers: { priority: {}, flex: {} } },
  }),
  entry({
    id: "xai/grok-4.5",
    tags: ["reasoning", "web-search"],
    reasoningEfforts: ["low"],
  }),
  entry({
    id: "deepseek/deepseek-v4-pro",
    tags: ["reasoning"],
    reasoningEfforts: ["none", "high", "max"],
  }),
  entry({
    id: "xai/grok-4.20-non-reasoning",
    tags: ["web-search"],
    pricing: {},
    reasoningEfforts: [],
  }),
  entry({
    id: "anthropic/claude-toggle-only",
    tags: ["reasoning"],
    reasoningEfforts: [],
  }),
  entry({
    id: "vendor/catalog-efforts-only",
    reasoningEfforts: ["high"],
  }),
];

describe("gatewayModelCapabilities", () => {
  it("reads reasoning from the catalog tag and Fast mode from the priority tier", () => {
    expect(gatewayModelCapabilities(CATALOG, "openai/gpt-5.5")).toEqual({
      reasoning: true,
      reasoningLevels: ["minimal", "high"],
      fastMode: true,
    });
    expect(gatewayModelCapabilities(CATALOG, "xai/grok-4.20-non-reasoning")).toEqual({
      reasoning: false,
      reasoningLevels: [],
      fastMode: false,
    });
    expect(
      gatewayModelCapabilities(CATALOG, "anthropic/claude-toggle-only")?.reasoningLevels,
    ).toEqual([]);
  });

  it("uses only each model's supported reasoning levels", () => {
    expect(gatewayModelCapabilities(CATALOG, "xai/grok-4.5")?.reasoningLevels).toEqual(["low"]);
    expect(gatewayModelCapabilities(CATALOG, "deepseek/deepseek-v4-pro")?.reasoningLevels).toEqual([
      "none",
      "high",
    ]);
    expect(gatewayModelCapabilities(CATALOG, "vendor/catalog-efforts-only")).toMatchObject({
      reasoning: true,
      reasoningLevels: ["high"],
    });
  });

  it("returns undefined without a catalog, a model id, or a catalog entry", () => {
    expect(gatewayModelCapabilities(undefined, "openai/gpt-5.5")).toBeUndefined();
    expect(gatewayModelCapabilities(CATALOG, null)).toBeUndefined();
    expect(gatewayModelCapabilities(CATALOG, "meta/llama-3.3-70b")).toBeUndefined();
  });
});
