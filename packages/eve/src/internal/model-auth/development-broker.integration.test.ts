import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DEVELOPMENT_WORKFLOW_SECRET_ENV,
  DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER,
} from "#internal/workflow/development-world-protocol.js";
import {
  DEVELOPMENT_MODEL_CREDENTIAL_ROUTE,
  DEVELOPMENT_MODEL_REJECTED_HEADER,
} from "./development-broker-protocol.js";

const mocks = vi.hoisted(() => ({
  environment: vi.fn(),
  gateway: vi.fn(),
  key: vi.fn(),
  chatgpt: vi.fn(),
}));
vi.mock("#cli/dev/environment.js", () => ({ loadDevelopmentEnvironmentFiles: mocks.environment }));
vi.mock("./gateway-credential.js", () => ({ resolveGatewayModelCredential: mocks.gateway }));
vi.mock("./api-key.js", () => ({ resolveModelApiKey: mocks.key }));
vi.mock("#public/models/openai/chatgpt/token-broker.js", () => ({
  getDefaultCodexTokenBroker: () => ({ getToken: mocks.chatgpt }),
}));
import { handleDevelopmentModelCredentialRequest } from "./development-broker-server.js";
import { readDevelopmentModelCredential } from "./development-broker-client.js";
import {
  createDirectModelFetch,
  localGatewayEvaluationModel,
  localGatewayModel,
} from "./transport.js";
import { createCodexFetch } from "#public/models/openai/chatgpt/transport.js";

const origin = "http://localhost:4567";
const secret = "fixture-transport-secret-that-is-not-a-model-token";
const host = { appRoot: "/fixture", secret };
const upstream = vi.fn();
const brokerRequests: Request[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  brokerRequests.length = 0;
  vi.stubEnv("EVE_DEV", "1");
  vi.stubEnv("EVE_DEV_CONTROL_URL", origin);
  vi.stubEnv(DEVELOPMENT_WORKFLOW_SECRET_ENV, secret);
  mocks.gateway.mockResolvedValue({
    kind: "oauth",
    token: "account-token",
    teamId: "team_a",
    teamName: "alice",
  });
  mocks.key.mockResolvedValue("key-token");
  mocks.chatgpt.mockResolvedValue({ token: "chatgpt-token", accountId: "account-a" });
  upstream.mockResolvedValue(new Response("{}"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (!String(url).startsWith(origin)) return upstream(url, init);
      const request = new Request(url, init);
      brokerRequests.push(request);
      return (
        (await handleDevelopmentModelCredentialRequest(request, host)) ??
        new Response(null, { status: 404 })
      );
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("rejects unauthenticated and invalid requests before reading any credentials", async () => {
  for (const headers of [{}, { [DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER]: "wrong" }]) {
    const response = await handleDevelopmentModelCredentialRequest(
      new Request(`${origin}${DEVELOPMENT_MODEL_CREDENTIAL_ROUTE}?provider=gateway`, { headers }),
      host,
    );
    expect(response?.status).toBe(401);
    expect(await response?.text()).not.toContain("account-token");
  }
  const headers = { [DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER]: secret };
  for (const provider of ["", "arbitrary-secret"]) {
    const response = await handleDevelopmentModelCredentialRequest(
      new Request(`${origin}${DEVELOPMENT_MODEL_CREDENTIAL_ROUTE}?provider=${provider}`, {
        headers,
      }),
      host,
    );
    expect(response?.status).toBe(400);
  }
  expect(mocks.environment).not.toHaveBeenCalled();
  expect(mocks.gateway).not.toHaveBeenCalled();
  expect(mocks.key).not.toHaveBeenCalled();
});

it("reads current host credentials and teams without restarting workers", async () => {
  expect(await readDevelopmentModelCredential("gateway")).toMatchObject({
    token: "account-token",
    teamName: "alice",
  });
  mocks.gateway.mockResolvedValue({
    kind: "oauth",
    token: "account-token",
    teamId: "team_b",
    teamName: "bob",
  });
  expect(await readDevelopmentModelCredential("gateway")).toMatchObject({
    token: "account-token",
    teamId: "team_b",
    teamName: "bob",
  });
  expect(mocks.gateway.mock.calls).toEqual([[], []]);
  expect(mocks.environment).toHaveBeenCalledWith("/fixture");
  expect(upstream).not.toHaveBeenCalled();
});

it("refreshes only the rejected token and never puts tokens in URLs", async () => {
  mocks.gateway
    .mockResolvedValueOnce({ kind: "oauth", token: "old-token" })
    .mockResolvedValue({ kind: "oauth", token: "new-token" });
  expect(await readDevelopmentModelCredential("gateway", "old-token")).toMatchObject({
    token: "new-token",
  });
  expect(mocks.gateway.mock.calls).toEqual([[], ["old-token"]]);
  expect(brokerRequests[0]?.headers.get(DEVELOPMENT_MODEL_REJECTED_HEADER)).toBe(
    createHash("sha256").update("old-token").digest("hex"),
  );
  expect(brokerRequests[0]?.url).not.toContain("old-token");
  await readDevelopmentModelCredential("gateway", "old-token");
  expect(mocks.gateway).toHaveBeenCalledTimes(3);
});

it.each(["openai", "anthropic"] as const)(
  "uses host-owned %s keys only in provider headers",
  async (provider) => {
    const url =
      provider === "openai"
        ? "https://api.openai.com/v1/responses"
        : "https://api.anthropic.com/v1/messages";
    const body = JSON.stringify({ model: "fixture", messages: [] });
    await createDirectModelFetch(provider)(url, { method: "POST", body });
    const [sentUrl, init] = upstream.mock.calls[0]!;
    expect(sentUrl).toBe(url);
    expect(init.body).toBe(body);
    expect(init.headers.get(provider === "openai" ? "authorization" : "x-api-key")).toBe(
      provider === "openai" ? "Bearer key-token" : "key-token",
    );
    expect(init.headers.has(DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER)).toBe(false);
  },
);

it("shares the host ChatGPT broker for requests and rejected-token refresh", async () => {
  mocks.chatgpt
    .mockResolvedValueOnce({ token: "old-token", accountId: "alice" })
    .mockResolvedValueOnce({ token: "old-token", accountId: "alice" })
    .mockResolvedValue({ token: "new-token", accountId: "bob" });
  upstream
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(new Response("{}"));
  await createCodexFetch()("https://api.openai.com/v1/responses", { method: "POST", body: "{}" });
  expect(mocks.chatgpt.mock.calls).toEqual([
    [{ reason: "request" }],
    [{ reason: "request" }],
    [{ reason: "rejected" }],
  ]);
  expect(upstream.mock.calls[1]?.[1].headers.get("authorization")).toBe("Bearer new-token");
  expect(upstream.mock.calls[1]?.[1].headers.get("ChatGPT-Account-Id")).toBe("bob");
});

it("keeps broker failures actionable without exposing resolver errors", async () => {
  mocks.gateway.mockRejectedValue(new Error("secret-provider-response"));
  await expect(readDevelopmentModelCredential("gateway")).rejects.toThrow("Run /login");
  const response = await handleDevelopmentModelCredentialRequest(brokerRequests[0]!, host);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(await response?.text()).not.toContain("secret-provider-response");
});

it("never contacts the broker in deployment or sends its secret to a remote URL", async () => {
  vi.stubEnv("EVE_DEV", "");
  expect(await readDevelopmentModelCredential("gateway")).toBeUndefined();
  vi.stubEnv("EVE_DEV", "1");
  vi.stubEnv("EVE_DEV_CONTROL_URL", "https://example.com");
  await expect(readDevelopmentModelCredential("gateway")).rejects.toThrow("Restart eve dev");
  expect(fetch).not.toHaveBeenCalled();
});

it("streams through the same Gateway model after switching teams and then to a key", async () => {
  const model = localGatewayModel("openai/gpt-5.6-luna-fast");
  if (!model || typeof model === "string") throw new Error("Expected a Gateway model");
  expect(JSON.stringify(model)).not.toContain("account-token");
  expect(mocks.gateway).not.toHaveBeenCalled();
  upstream.mockImplementation(
    async () =>
      new Response(
        [
          'data: {"type":"text-start","id":"text-1"}\n\n',
          'data: {"type":"text-delta","id":"text-1","delta":"Hello Alice."}\n\n',
          'data: {"type":"text-end","id":"text-1"}\n\n',
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const connections = [
    { kind: "oauth", token: "account-token", teamId: "team_a" },
    { kind: "oauth", token: "account-token", teamId: "team_b" },
    { kind: "api-key", token: "gateway-key" },
  ];
  for (const connection of connections) {
    mocks.gateway.mockResolvedValue(connection);
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    });
    let text = "";
    for await (const event of result.stream) {
      if (event.type === "error") throw event.error;
      if (event.type === "text-delta") text += event.delta;
    }
    expect(text).toBe("Hello Alice.");
    const [url, init] = upstream.mock.calls.at(-1)!;
    expect(new URL(String(url)).origin).toBe("https://ai-gateway.vercel.sh");
    expect(init.headers.get("authorization")).toBe(`Bearer ${connection.token}`);
    expect(init.headers.get("x-vercel-ai-gateway-team")).toBe(connection.teamId ?? null);
    expect(init.headers.has(DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER)).toBe(false);
    expect(init.body).not.toContain(connection.token);
  }
});

it("evaluates through the Gateway connection selected by /login", async () => {
  const model = localGatewayEvaluationModel("typesafe-ai/jev");
  if (!model) throw new Error("Expected a Gateway evaluation model");
  expect(JSON.stringify(model)).not.toContain("account-token");
  expect(mocks.gateway).not.toHaveBeenCalled();
  upstream.mockResolvedValue(
    Response.json({
      answers: { route: { type: "choice", choice: "fast" } },
      usage: { inputTokens: 4, outputTokens: 1 },
    }),
  );

  const result = await model.doEvaluate({
    state: "Alice requests a routine summary.",
    questions: {
      route: {
        type: "choice",
        instructions: "Choose a model.",
        criteria: { fast: "Routine work", thorough: "Difficult work" },
      },
    },
  });

  expect(result.answers.route).toEqual({ type: "choice", choice: "fast" });
  const [url, init] = upstream.mock.calls[0]!;
  expect(String(url)).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
  expect(init.headers.get("authorization")).toBe("Bearer account-token");
  expect(init.headers.get("x-vercel-ai-gateway-team")).toBe("team_a");
  expect(init.headers.get("ai-model-id")).toBe("typesafe-ai/jev");
  expect(init.headers.has(DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER)).toBe(false);
  expect(init.body).not.toContain("account-token");
});

it("cancels credential lookup with the model request", async () => {
  const controller = new AbortController();
  controller.abort(new Error("request-cancelled"));
  vi.mocked(fetch).mockImplementation(async (_url, init) => {
    init?.signal?.throwIfAborted();
    throw new Error("Expected the cancellation signal");
  });
  await expect(
    createDirectModelFetch("openai")("https://api.openai.com/v1/responses", {
      signal: controller.signal,
    }),
  ).rejects.toThrow("request-cancelled");
  expect(mocks.key).not.toHaveBeenCalled();
  expect(upstream).not.toHaveBeenCalled();
});
