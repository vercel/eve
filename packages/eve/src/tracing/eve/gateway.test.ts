import { describe, expect, it } from "vitest";

import { gatewayRoutingAttributes } from "#tracing/eve/gateway.js";

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
