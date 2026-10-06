import { expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import {
  createMcpInputRequiredFetch,
  parseInputRequiredResult,
  runMcpRequestScope,
} from "#runtime/connections/mcp-input-required.js";

const FORM = {
  method: "elicitation/create",
  params: {
    message: "Delete the repo?",
    requestedSchema: { properties: { confirm: { type: "boolean" } }, type: "object" },
  },
};
const TokenCacheKey = new ContextKey<string>("test.mcpInputRequired.tokenCache");

// Two calls in one step share one context container; each keeps its own retry
// fields and result, and writes made inside a scope still land on the container.
it("keeps concurrent scopes separate inside one shared context", async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const base = vi.fn(async (_request: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number };
    if (body.id === 1) {
      await firstGate;
      return jsonResponse({
        id: 1,
        jsonrpc: "2.0",
        result: {
          inputRequests: { approve: FORM },
          requestState: "state-a",
          resultType: "input_required",
        },
      });
    }
    return jsonResponse({ id: 2, jsonrpc: "2.0", result: { content: [] } });
  });
  const fetcher = createMcpInputRequiredFetch(base);
  const shared = new ContextContainer();

  const [first, second] = await contextStorage.run(shared, async () => {
    const a = runMcpRequestScope({
      execute: () => sdkCall(fetcher, 1),
      retry: { requestState: "retry-a" },
    });
    const b = runMcpRequestScope({
      execute: async () => {
        contextStorage.getStore()!.set(TokenCacheKey, "token-b");
        return await sdkCall(fetcher, 2);
      },
      retry: { inputResponses: { b: { action: "decline" } }, requestState: "retry-b" },
    });
    await b;
    releaseFirst();
    return await Promise.all([a, b]);
  });

  expect(second).toMatchObject({ status: "completed" });
  expect(first).toMatchObject({ requestState: "state-a", status: "input_required" });
  expect(shared.get(TokenCacheKey)).toBe("token-b");
  const sent = base.mock.calls.map(
    ([, init]) => JSON.parse(String(init?.body)) as { id: number; params: Record<string, unknown> },
  );
  const a = sent.find((message) => message.id === 1)!;
  const b = sent.find((message) => message.id === 2)!;
  expect(a.params).toMatchObject({ requestState: "retry-a" });
  expect(a.params).not.toHaveProperty("inputResponses");
  expect(b.params).toMatchObject({
    inputResponses: { b: { action: "decline" } },
    requestState: "retry-b",
  });
});

// What an untrusted server sends lands in session state and the user's prompt.
it("refuses input_required content over its caps", () => {
  const elicit = (params: object) => ({ method: "elicitation/create", params });
  const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`r${i}`, elicit({})]));
  const rows: Array<[Record<string, unknown>, string | undefined]> = [
    [{ requestState: "s".repeat(64 * 1024) }, undefined],
    [{ requestState: "s".repeat(64 * 1024 + 1) }, "requestState over 65536"],
    [{ inputRequests: many }, "more than 16 inputRequests"],
    [{ inputRequests: { a: elicit({ message: "m".repeat(8 * 1024 + 1) }) } }, "message over 8192"],
    [
      { inputRequests: { a: elicit({ url: `https://x/${"u".repeat(8 * 1024)}` }) } },
      "url over 8192",
    ],
  ];
  for (const [result, refused] of rows) {
    const parsed = parseInputRequiredResult(result);
    if (refused === undefined) expect(typeof parsed).toBe("object");
    else expect(parsed).toContain(refused);
  }
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

/** Stands in for `@ai-sdk/mcp`, which throws on an `input_required` result. */
async function sdkCall(fetcher: typeof fetch, id: number): Promise<unknown> {
  const body = JSON.stringify({
    id,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: {}, name: "danger" },
  });
  const text = await (await fetcher("https://mcp.example.com", { body, method: "POST" })).text();
  if (text.includes("input_required")) throw new Error("SDK: unknown result");
  return text;
}
