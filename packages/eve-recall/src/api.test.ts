import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveRecallWebhookUrl, sendRecallChatMessage } from "./api.js";

describe("resolveRecallWebhookUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  function deployment(env: string) {
    vi.stubEnv("RECALL_WEBHOOK_URL", "");
    vi.stubEnv("WORKFLOW_LOCAL_BASE_URL", "");
    vi.stubEnv("VERCEL_ENV", env);
    vi.stubEnv("VERCEL_URL", "agent-abc123.vercel.app");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "agent.vercel.app");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "bypass");
  }

  it("points a preview's bots at the preview, without the deployment's bypass secret", () => {
    deployment("preview");
    expect(resolveRecallWebhookUrl()).toBe("https://agent-abc123.vercel.app/eve/v1/recall");
  });

  it("points production bots at the production URL, under the agent's route prefix", () => {
    deployment("production");
    vi.stubEnv("EVE_PUBLIC_ROUTE_PREFIX", "/support");
    expect(resolveRecallWebhookUrl()).toBe("https://agent.vercel.app/support/eve/v1/recall");
  });

  it("prefers RECALL_WEBHOOK_URL, and asks for it outside a deployment", () => {
    deployment("development");
    expect(() => resolveRecallWebhookUrl()).toThrow(/RECALL_WEBHOOK_URL/u);
    vi.stubEnv("RECALL_WEBHOOK_URL", "https://tunnel.example/eve/v1/recall");
    expect(resolveRecallWebhookUrl()).toBe("https://tunnel.example/eve/v1/recall");
  });
});

describe("sendRecallChatMessage", () => {
  it("splits a message at line breaks to fit Google Meet's 500-character chat", async () => {
    const bodies: { message: string }[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as { message: string });
      return new Response("{}");
    });
    const line = "x".repeat(300);

    await sendRecallChatMessage({
      apiKey: "key",
      botId: "bot_1",
      fetch: fetch as never,
      message: `${line}\n${line}`,
      platform: "google_meet",
    });

    expect(bodies.map(({ message }) => message)).toEqual([line, line]);
  });
});
