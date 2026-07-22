import { describe, expect, it } from "vitest";

import { gatewayModelCapabilities } from "./model-capabilities.js";
import type { GatewayCatalogModel } from "./select-model.js";

function entry(overrides: Partial<GatewayCatalogModel> & { id: string }): GatewayCatalogModel {
  return {
    name: overrides.id,
    type: "language",
    owned_by: overrides.id.split("/")[0] ?? "",
    ...overrides,
  };
}

const CATALOG: GatewayCatalogModel[] = [
  entry({
    id: "openai/gpt-5.5",
    tags: ["reasoning", "web-search"],
    pricing: { service_tiers: { priority: {}, flex: {} } },
  }),
  entry({ id: "xai/grok-4.5", tags: ["reasoning", "web-search"] }),
  entry({ id: "deepseek/deepseek-v4-pro", tags: ["reasoning"] }),
  entry({ id: "xai/grok-4.20-non-reasoning", tags: ["web-search"], pricing: {} }),
];

describe("gatewayModelCapabilities", () => {
  it("reads reasoning from the catalog tag and Fast mode from the priority tier", () => {
    expect(gatewayModelCapabilities(CATALOG, "openai/gpt-5.5")).toEqual({
      reasoning: true,
      reasoningLevels: ["none", "minimal", "low", "medium", "high", "xhigh"],
      fastMode: true,
    });
    expect(gatewayModelCapabilities(CATALOG, "xai/grok-4.20-non-reasoning")).toEqual({
      reasoning: false,
      reasoningLevels: [],
      fastMode: false,
    });
  });

  it("narrows reasoning levels per provider and falls back to the common core", () => {
    expect(gatewayModelCapabilities(CATALOG, "xai/grok-4.5")?.reasoningLevels).toEqual([
      "low",
      "high",
    ]);
    expect(gatewayModelCapabilities(CATALOG, "deepseek/deepseek-v4-pro")?.reasoningLevels).toEqual([
      "none",
      "low",
      "medium",
      "high",
    ]);
  });

  it("returns undefined without a catalog, a model id, or a catalog entry", () => {
    expect(gatewayModelCapabilities(undefined, "openai/gpt-5.5")).toBeUndefined();
    expect(gatewayModelCapabilities(CATALOG, null)).toBeUndefined();
    expect(gatewayModelCapabilities(CATALOG, "meta/llama-3.3-70b")).toBeUndefined();
  });
});
