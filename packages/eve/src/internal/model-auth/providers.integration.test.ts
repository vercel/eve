import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), session: vi.fn() }));
vi.mock("./store.js", () => ({
  readModelSecret: mocks.read,
  modelKeySecretName: (name: string) => `${name}-key`,
}));
vi.mock("./vercel.js", () => ({
  resolveVercelSession: mocks.session,
  VERCEL_TEAM_HEADER: "x-vercel-ai-gateway-team",
}));
import { openai } from "#public/models/openai/index.js";
import { anthropic } from "#public/models/anthropic/index.js";
import { localGatewayModel } from "./transport.js";
beforeEach(() => {
  vi.stubEnv("EVE_DEV", "1");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  mocks.read.mockResolvedValue("test-secret");
  mocks.session.mockResolvedValue({ accessToken: "account-token", teamId: "team_original" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
it.each([
  ["openai", "https://api.openai.com/v1/responses"],
  ["anthropic", "https://api.anthropic.com/v1/messages"],
])(
  "routes the public %s helper to its direct endpoint without exposing keys in the body",
  async (provider, endpoint) => {
    const fetch = vi.fn(
      async (_url: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) =>
        new Response("", { status: 401 }),
    );
    vi.stubGlobal("fetch", fetch);
    const model = provider === "openai" ? openai() : anthropic();
    if (typeof model === "string") throw new Error("Expected a provider model");
    await expect(
      model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(endpoint);
    const headers = new Headers(init?.headers);
    expect(headers.get(provider === "openai" ? "authorization" : "x-api-key")).toBe(
      provider === "openai" ? "Bearer test-secret" : "test-secret",
    );
    expect(init?.body).not.toContain("test-secret");
  },
);
it("sends account credentials and the project team to Gateway, then refreshes once on rejection", async () => {
  vi.stubEnv("EVE_MODEL_CONNECTION", "vercel");
  vi.stubEnv("EVE_MODEL_TEAM", "team_project");
  mocks.session
    .mockResolvedValueOnce({ accessToken: "old-token", teamId: "team_original" })
    .mockResolvedValueOnce({ accessToken: "new-token", teamId: "team_original" });
  const requests: { url: string; headers: Headers; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers), body: init?.body });
      return new Response("", { status: 401 });
    }),
  );
  const model = localGatewayModel("openai/gpt-5.6-luna-fast");
  if (!model || typeof model === "string") throw new Error("Expected Gateway model");
  await expect(
    model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] }),
  ).rejects.toThrow();
  expect(requests).toHaveLength(2);
  expect(new URL(requests[0]!.url).hostname).toBe("ai-gateway.vercel.sh");
  expect(requests[0]!.headers.get("authorization")).toBe("Bearer old-token");
  expect(requests[1]!.headers.get("authorization")).toBe("Bearer new-token");
  expect(
    requests.every((request) => request.headers.get("x-vercel-ai-gateway-team") === "team_project"),
  ).toBe(true);
  expect(JSON.stringify(requests.map((request) => request.body))).not.toContain("token");
});

it("streams the first response with a newly saved connection", async () => {
  const item = { type: "message", id: "msg_1", role: "assistant", content: [] };
  const events = [
    { type: "response.output_item.added", output_index: 0, item },
    {
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      delta: "Hello Alice.",
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        created_at: 0,
        model: "gpt-5.6-luna-fast",
        status: "completed",
        usage: { input_tokens: 3, output_tokens: 3 },
      },
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        }),
    ),
  );
  const model = openai();
  if (typeof model === "string") throw new Error("Expected OpenAI model");
  const result = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  });
  let text = "";
  for await (const event of result.stream) {
    if (event.type === "error") throw event.error;
    if (event.type === "text-delta") text += event.delta;
  }
  expect(text).toBe("Hello Alice.");
});
