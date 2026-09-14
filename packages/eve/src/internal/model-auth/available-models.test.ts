import { afterEach, expect, it, vi } from "vitest";
vi.mock("#public/models/openai/chatgpt/token-broker.js", () => ({
  getDefaultCodexTokenBroker: () => ({
    getToken: async () => ({ token: "test-token", accountId: "test-account" }),
  }),
}));
import { availableHelperModels } from "./available-models.js";

afterEach(() => vi.unstubAllGlobals());

it("loads ChatGPT catalogs with large embedded model instructions after sign-in", async () => {
  const fetch = vi.fn(async () =>
    Response.json({
      models: [{ slug: "gpt-5.6-luna-fast", instructions: "x".repeat(300_000) }],
    }),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(availableHelperModels("chatgpt")).resolves.toEqual(["gpt-5.6-luna-fast"]);
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining("/backend-api/codex/models"),
    expect.objectContaining({
      headers: expect.objectContaining({ "ChatGPT-Account-Id": "test-account" }),
    }),
  );
});

it("still bounds catalog response sizes", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({ models: [], padding: "x".repeat(8 * 1024 * 1024) }),
  );
  await expect(availableHelperModels("chatgpt")).rejects.toThrow("too large");
});
