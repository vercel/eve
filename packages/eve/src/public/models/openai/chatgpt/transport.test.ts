import { describe, expect, it, vi } from "vitest";

import type { CodexTokenBroker } from "./token-broker.js";
import { createCodexFetch, rewriteCodexEndpoint } from "./transport.js";

const CODEX_ENDPOINT = "https://chatgpt.test/backend-api/codex/responses";

describe("Codex direct transport", () => {
  it("routes Responses requests through the Codex backend with brokered ChatGPT auth", async () => {
    const requests: RecordedRequest[] = [];
    const broker = fakeBroker([{ accountId: "acct-1", token: "access-token" }]);
    const codexFetch = createCodexFetch({
      broker,
      codexApiEndpoint: CODEX_ENDPOINT,
      fetch: createRecordingFetch(requests),
    });

    await codexFetch("https://api.openai.com/v1/responses", {
      body: '{"stream":true}',
      headers: { authorization: "[redacted]", "content-type": "application/json" },
      method: "POST",
    });

    expect(broker.getToken).toHaveBeenCalledWith({ reason: "request" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "POST", url: CODEX_ENDPOINT });
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer access-token");
    expect(requests[0]?.headers.get("ChatGPT-Account-Id")).toBe("acct-1");
    expect(requests[0]?.headers.get("originator")).toBe("eve");
  });

  it("refreshes through the broker and replays one string-body request after 401", async () => {
    const requests: RecordedRequest[] = [];
    const broker = fakeBroker([{ token: "stale-token" }, { token: "fresh-token" }]);
    const codexFetch = createCodexFetch({
      broker,
      codexApiEndpoint: CODEX_ENDPOINT,
      fetch: createRecordingFetch(requests, (request) =>
        Promise.resolve(
          new Response(null, {
            status: request.headers.get("authorization") === "Bearer stale-token" ? 401 : 200,
          }),
        ),
      ),
    });

    const response = await codexFetch("https://api.openai.com/v1/responses", {
      body: JSON.stringify({
        input: [{ type: "reasoning", id: "rs_1", encrypted_content: "encrypted-reasoning" }],
        stream: true,
      }),
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(broker.getToken).toHaveBeenNthCalledWith(1, { reason: "request" });
    expect(broker.getToken).toHaveBeenNthCalledWith(2, { reason: "rejected" });
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer stale-token",
      "Bearer fresh-token",
    ]);
    expect(requests.map((request) => JSON.parse(request.body ?? "{}"))).toEqual([
      {
        input: [{ type: "reasoning", encrypted_content: "encrypted-reasoning" }],
        stream: true,
      },
      {
        input: [{ type: "reasoning", encrypted_content: "encrypted-reasoning" }],
        stream: true,
      },
    ]);
  });

  it("removes response item ids without changing stateless replay data", async () => {
    const requests: RecordedRequest[] = [];
    const codexFetch = createCodexFetch({
      broker: fakeBroker([{ token: "access-token" }]),
      codexApiEndpoint: CODEX_ENDPOINT,
      fetch: createRecordingFetch(requests),
    });

    await codexFetch("https://api.openai.com/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            type: "reasoning",
            id: "rs_1",
            encrypted_content: "encrypted-reasoning",
            summary: [{ type: "summary_text", text: "summary" }],
          },
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "lookup",
            arguments: '{"id":"argument-id"}',
          },
        ],
        stream: true,
      }),
      headers: { "content-length": "999", "content-type": "application/json" },
      method: "POST",
    });

    expect(requests[0]?.headers.has("content-length")).toBe(false);
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      input: [
        {
          type: "reasoning",
          encrypted_content: "encrypted-reasoning",
          summary: [{ type: "summary_text", text: "summary" }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "lookup",
          arguments: '{"id":"argument-id"}',
        },
      ],
      stream: true,
    });
  });

  it("does not replay a Request body after 401", async () => {
    const requests: RecordedRequest[] = [];
    const broker = fakeBroker([{ token: "stale-token" }]);
    const codexFetch = createCodexFetch({
      broker,
      fetch: createRecordingFetch(requests, () =>
        Promise.resolve(new Response(null, { status: 401 })),
      ),
    });

    const response = await codexFetch(
      new Request("https://api.openai.com/v1/responses", {
        body: '{"stream":true}',
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
    expect(broker.getToken).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
  });

  it("matches the Codex endpoint rewrite boundary", () => {
    expect(rewriteCodexEndpoint("https://api.openai.com/v1/responses", CODEX_ENDPOINT)).toBe(
      CODEX_ENDPOINT,
    );
    expect(rewriteCodexEndpoint("https://api.openai.com/chat/completions", CODEX_ENDPOINT)).toBe(
      CODEX_ENDPOINT,
    );
    expect(rewriteCodexEndpoint("https://api.openai.com/v1/models", CODEX_ENDPOINT)).toBe(
      "https://api.openai.com/v1/models",
    );
  });
});

interface RecordedRequest {
  readonly body: string | undefined;
  readonly headers: Headers;
  readonly method: string | undefined;
  readonly url: string;
}

function fakeBroker(
  tokens: Array<{ readonly accountId?: string; readonly token: string }>,
): CodexTokenBroker {
  return {
    getToken: vi.fn(async () => {
      const token = tokens.shift();
      if (token === undefined) throw new Error("No token configured.");
      return token;
    }),
    refreshState: async () => ({ kind: "checking" }),
    state: () => ({ kind: "checking" }),
  };
}

function createRecordingFetch(
  requests: RecordedRequest[],
  responseForRequest: (request: RecordedRequest) => Promise<Response> = async () =>
    Response.json({ ok: true }),
): typeof fetch {
  return async (input, init) => {
    const request = {
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: new Headers(init?.headers),
      method: init?.method,
      url: input instanceof Request ? input.url : input.toString(),
    };
    requests.push(request);
    return responseForRequest(request);
  };
}
