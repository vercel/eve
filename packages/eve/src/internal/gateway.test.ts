import { describe, expect, it } from "vitest";

import { addGatewayUA, buildGatewayURL } from "#internal/gateway.js";

describe("Gateway request helpers", () => {
  it("builds paths against the Gateway origin", () => {
    expect(buildGatewayURL("/v1/models/catalog")).toBe(
      "https://ai-gateway.vercel.sh/v1/models/catalog",
    );
  });

  it("appends the package product to an existing user-agent once", () => {
    const headers = new Headers({ "user-agent": "ai-sdk/6.0.0" });

    addGatewayUA(headers);
    addGatewayUA(headers);

    expect(headers.get("user-agent")).toMatch(/^ai-sdk\/6\.0\.0 eve\/[^ ]+$/);
  });
});
