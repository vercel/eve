import { describe, expect, it, vi } from "vitest";

import { writeAiGatewayApiKey } from "./ai-gateway-api-key.js";

describe("writeAiGatewayApiKey", () => {
  it("trims and replaces the key in the project env file", async () => {
    const appendEnv = vi.fn(async () => ({ written: ["AI_GATEWAY_API_KEY"], skipped: [] }));

    await expect(
      writeAiGatewayApiKey({ projectRoot: "/app/my-agent", apiKey: "  sk-test  ", appendEnv }),
    ).resolves.toEqual({
      envKey: "AI_GATEWAY_API_KEY",
      envFile: ".env.local",
      envPath: "/app/my-agent/.env.local",
    });

    expect(appendEnv).toHaveBeenCalledExactlyOnceWith(
      "/app/my-agent/.env.local",
      { AI_GATEWAY_API_KEY: "sk-test" },
      { force: true },
    );
  });
});
