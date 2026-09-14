import { afterEach, expect, it, vi } from "vitest";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
const state = vi.hoisted(() => ({
  key: "",
  model: vi.fn(),
  selection: vi.fn(),
  defaults: vi.fn(),
}));
vi.mock("#internal/model-auth/store.js", async (original) => ({
  ...(await original<typeof import("#internal/model-auth/store.js")>()),
  readModelSecret: async () => state.key,
  writeModelSecret: async (_name: string, key: string) => {
    state.key = key;
  },
  writeDefaultConnection: state.defaults,
}));
vi.mock("#setup/provider-settings.js", async (original) => ({
  ...(await original<typeof import("#setup/provider-settings.js")>()),
  writeProviderSelection: state.selection,
}));
vi.mock("#services/inspect-application.js", () => ({
  inspectApplication: async () => ({
    compiledState: {
      manifest: {
        config: { model: { id: "openai/gpt-5.6-luna-fast", routing: { kind: "gateway" } } },
      },
    },
  }),
}));
vi.mock("./model-source-change.js", () => ({ changeAgentModel: state.model }));
import { runModelLogin } from "./model-login.js";
import { openai } from "#public/models/openai/index.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  state.key = "";
});
it("logs in and streams the first response without exposing the entered key", async () => {
  vi.stubEnv("EVE_DEV", "1");
  vi.stubEnv("OPENAI_API_KEY", "");
  state.model.mockResolvedValue({ kind: "changed" });
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
  const fetch = vi.fn(async (url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-key");
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "gpt-5.6-luna-fast" }] });
    expect(String(url)).toBe("https://api.openai.com/v1/responses");
    expect(init?.body).not.toContain("fixture-key");
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  const fake = createFakePrompter({ single: () => "openai", password: () => "fixture-key" });
  expect(await runModelLogin({ appRoot: "/fixture", prompter: fake.prompter })).toEqual({
    kind: "ready",
  });
  expect(state.model).toHaveBeenCalledWith({
    appRoot: "/fixture",
    slug: "openai-api/gpt-5.6-luna-fast",
  });
  expect(state.defaults).toHaveBeenCalledWith("openai");
  expect(JSON.stringify(fake)).not.toContain("fixture-key");
  const model = openai();
  if (typeof model === "string") throw new Error("Expected a model");
  const response = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  });
  let text = "";
  for await (const event of response.stream) {
    if (event.type === "error") throw event.error;
    if (event.type === "text-delta") text += event.delta;
  }
  expect(text).toBe("Hello Alice.");
});
