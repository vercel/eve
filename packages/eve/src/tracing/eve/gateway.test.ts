import { describe, expect, it } from "vitest";

import { gatewayModelCallCostAttributes, gatewayRoutingAttributes } from "#tracing/eve/gateway.js";

describe("gatewayModelCallCostAttributes", () => {
  it("records the Gateway's cost under the OTel GenAI cost names", () => {
    expect(
      gatewayModelCallCostAttributes({
        cost: 0.02,
        gatewayCost: 0.021,
        generationId: "gen_1",
        inputCost: 0.015,
        outputCost: 0.006,
      }),
    ).toEqual({
      "gen_ai.usage.cost.amount": 0.021,
      "gen_ai.usage.cost.currency": "USD",
      "gen_ai.usage.cost.input": 0.015,
      "gen_ai.usage.cost.output": 0.006,
      "gen_ai.usage.cost.source": "provider",
      "vercel.ai_gateway.generation.id": "gen_1",
    });
  });

  it("leaves currency and source off when the Gateway reported no cost", () => {
    expect(gatewayModelCallCostAttributes({ generationId: "gen_1" })).toEqual({
      "gen_ai.usage.cost.amount": undefined,
      "gen_ai.usage.cost.currency": undefined,
      "gen_ai.usage.cost.input": undefined,
      "gen_ai.usage.cost.output": undefined,
      "gen_ai.usage.cost.source": undefined,
      "vercel.ai_gateway.generation.id": "gen_1",
    });
  });
});

describe("gatewayRoutingAttributes", () => {
  it("records the Gateway's session affinity on the model run's attempt", () => {
    expect(
      gatewayRoutingAttributes({
        gateway: {
          cost: "0.000182",
          routing: {
            affinity: {
              displacedProvider: "bedrock",
              outcome: "promoted",
              pinnedProvider: "anthropic",
            },
            clientSessionId: "conversation-1",
            clientSessionIdSource: "explicit",
          },
        },
      }),
    ).toEqual({
      "vercel.ai_gateway.affinity.displaced_provider": "bedrock",
      "vercel.ai_gateway.affinity.outcome": "promoted",
      "vercel.ai_gateway.affinity.pinned_provider": "anthropic",
      "vercel.ai_gateway.client_session_id": "conversation-1",
      "vercel.ai_gateway.client_session_id_source": "explicit",
    });
  });

  it("records nothing for routing a provider other than the Gateway reports", () => {
    expect(
      gatewayRoutingAttributes({
        anthropic: {
          routing: { affinity: { outcome: "confirmed" }, clientSessionId: "conversation-1" },
        },
      }),
    ).toBeUndefined();
  });
});
