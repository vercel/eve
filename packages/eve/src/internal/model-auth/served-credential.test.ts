// A served credential URL (EVE_MODEL_CREDENTIAL_URL) on the path a dev turn
// takes: the worker's Gateway model asks eve dev's credential relay, and the
// relay asks the served URL with the real resolver.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEVELOPMENT_WORKFLOW_SECRET_ENV } from "#internal/workflow/development-world-protocol.js";
import { DEVELOPMENT_MODEL_REJECTED_HEADER } from "./development-broker-protocol.js";

vi.mock("#cli/dev/environment.js", () => ({ loadDevelopmentEnvironmentFiles: vi.fn() }));
vi.mock("./store.js", () => ({ readModelSecret: vi.fn(), modelKeySecretName: (n: string) => n }));
vi.mock("#public/models/openai/chatgpt/token-broker.js", () => ({
  getDefaultCodexTokenBroker: vi.fn(),
}));
import { handleDevelopmentModelCredentialRequest } from "./development-broker-server.js";
import { readDevelopmentModelCredential } from "./development-broker-client.js";
import { localGatewayModel } from "./transport.js";

const origin = "http://localhost:4567";
const secret = "fixture-transport-secret";
const served = "https://hub.example/api/model-credential";
const hub = vi.fn<(request: Request) => Promise<Response>>();
const gateway = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
beforeEach(() => {
  vi.stubEnv("EVE_DEV", "1");
  vi.stubEnv("EVE_DEV_CONTROL_URL", origin);
  vi.stubEnv(DEVELOPMENT_WORKFLOW_SECRET_ENV, secret);
  vi.stubEnv("EVE_MODEL_CONNECTION", "");
  vi.stubEnv("AI_GATEWAY_API_KEY", "");
  vi.stubEnv("EVE_MODEL_CREDENTIAL_URL", served);
  vi.stubEnv("EVE_MODEL_CREDENTIAL_TOKEN", "bot-token");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(url, init);
      if (request.url.startsWith(origin))
        return (
          (await handleDevelopmentModelCredentialRequest(request, {
            appRoot: "/fixture",
            secret,
          })) ?? new Response(null, { status: 404 })
        );
      if (request.url === served) return hub(request);
      return gateway(String(url), init ?? {});
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  hub.mockReset();
  gateway.mockReset();
});

it("refreshes a token Gateway refused by asking the served URL with its hash", async () => {
  const stale = createHash("sha256").update("stale").digest("hex");
  // The served URL hands out its live token until it is named as refused.
  hub.mockImplementation(async (request) =>
    Response.json({
      kind: "oauth",
      token: request.headers.get(DEVELOPMENT_MODEL_REJECTED_HEADER) === stale ? "fresh" : "stale",
    }),
  );
  // The transport reuses one Headers across its retry, so read it as each call is sent.
  const sent: (string | null)[] = [];
  gateway.mockImplementation(async (_url, init) =>
    sent.push(new Headers(init.headers).get("authorization")) && sent.at(-1) === "Bearer stale"
      ? new Response(null, { status: 401 })
      : new Response(
          'data: {"type":"text-start","id":"t"}\n\ndata: {"type":"text-delta","id":"t","delta":"pong"}\n\ndata: {"type":"text-end","id":"t"}\n\n',
          {
            headers: { "content-type": "text/event-stream" },
          },
        ),
  );
  const model = localGatewayModel("anthropic/claude-sonnet-4.5");
  if (!model || typeof model === "string") throw new Error("Expected a Gateway model");
  const result = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
  });
  let text = "";
  for await (const event of result.stream) {
    if (event.type === "error") throw event.error;
    if (event.type === "text-delta") text += event.delta;
  }
  expect(text).toBe("pong");
  expect(sent).toEqual(["Bearer stale", "Bearer fresh"]);
  expect(hub.mock.calls.map(([r]) => r.headers.get("authorization"))).toEqual(
    Array(3).fill("Bearer bot-token"),
  );
  expect(hub.mock.calls.map(([r]) => r.headers.get(DEVELOPMENT_MODEL_REJECTED_HEADER))).toEqual([
    null,
    null,
    stale,
  ]);
});

it("brings the served URL's own error to the turn", async () => {
  hub.mockResolvedValue(
    Response.json({ error: "the Vercel sign-in needs renewing in the app" }, { status: 401 }),
  );
  await expect(readDevelopmentModelCredential("gateway")).rejects.toThrow(
    "the Vercel sign-in needs renewing in the app",
  );
});
