import assert from "node:assert/strict";
import { test } from "node:test";
import { captureFetch, requestEvidence, responseEvidence } from "./prompt-cache-capture.mjs";

const headers = new Headers({
  "ai-language-model-id": "anthropic/test",
  authorization: "Bearer never-log-this",
});
const request = {
  prompt: [{ role: "user", content: [{ type: "text", text: "private-prompt" }] }],
  tools: [{ type: "function", name: "reviewer", inputSchema: { type: "object" } }],
  reasoning: "high",
  providerOptions: {
    gateway: { caching: "auto" },
    anthropic: { metadata: { userId: "private-identity" } },
  },
};
const evidence = (body) => requestEvidence(JSON.stringify(body), headers);

test("captures stable parameters and exact prefix without prompt text or credentials", () => {
  const first = evidence(request);
  const second = evidence({
    ...request,
    prompt: [...request.prompt, { role: "assistant", content: "answer" }],
  });
  assert.equal(first.parameters, second.parameters);
  assert.deepEqual(first.messages, second.messages.slice(0, 1));
  assert.equal(first.autoCaching, true);
  for (const secret of ["private-prompt", "private-identity", "never-log-this"]) {
    assert(!JSON.stringify(first).includes(secret));
  }
});

test("detects tool order, safety identifier, reasoning and cache option changes", () => {
  const original = evidence(request);
  for (const change of [
    { tools: [...request.tools, { name: "another" }] },
    { reasoning: "low" },
    { providerOptions: { gateway: { caching: false } } },
    {
      providerOptions: {
        ...request.providerOptions,
        anthropic: { metadata: { userId: "changed" } },
      },
    },
  ])
    assert.notEqual(evidence({ ...request, ...change }).parameters, original.parameters);
  const tools = [...request.tools, { name: "second" }];
  assert.notEqual(
    evidence({ ...request, tools }).parameters,
    evidence({ ...request, tools: tools.toReversed() }).parameters,
  );
});

test("never copies open-ended provider metadata or model text", () => {
  assert.equal(responseEvidence({ type: "text-delta", delta: "secret" }), undefined);
  const result = responseEvidence({
    type: "finish",
    usage: { inputTokens: { total: 10, secret: "do-not-log" } },
    providerMetadata: {
      gateway: {
        generationId: "gen_test",
        asyncJob: { webhookSigningSecret: "do-not-log" },
        routing: { secret: "do-not-log" },
      },
    },
  });
  assert(!JSON.stringify(result).includes("do-not-log"));
  assert.deepEqual(result.usage.inputTokens, { total: 10 });
});

test("fetch receives the original arguments and its response bytes remain unchanged", async () => {
  const url = "https://ai-gateway.vercel.sh/v3/ai/language-model";
  const init = {
    method: "POST",
    headers,
    body: JSON.stringify(request),
    signal: new AbortController().signal,
  };
  const events = [];
  const wire =
    'data: {"type":"response-metadata","id":"msg_test"}\n\ndata: {"type":"text-delta","delta":"private-answer"}\n\ndata: {"type":"finish","usage":{"inputTokens":{"cacheRead":10}},"providerMetadata":{"gateway":{"generationId":"gen_test"}}}\n\ndata: [DONE]\n\n';
  const fetch = captureFetch(
    async (receivedUrl, receivedInit) => {
      assert.equal(receivedUrl, url);
      assert.equal(receivedInit, init);
      return new Response(
        new ReadableStream({
          start(controller) {
            const bytes = new TextEncoder().encode(wire);
            controller.enqueue(bytes.slice(0, 19));
            controller.enqueue(bytes.slice(19));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream", "x-vercel-id": "test-request" } },
      );
    },
    (event) => events.push(event),
  );
  const response = await fetch(url, init);
  assert.equal(await response.text(), wire);
  assert.deepEqual(
    events.map((event) => event.type),
    ["request", "headers", "response-metadata", "finish"],
  );
  assert.equal(new Set(events.map((event) => event.id)).size, 1);
  assert(!JSON.stringify(events).includes("private-answer"));
});

test("does not inspect other destinations or consume nonstreaming responses", async () => {
  const original = new Response("unchanged");
  const fetch = captureFetch(
    async () => original,
    () => assert.fail("unexpected capture"),
  );
  assert.equal(await fetch("https://example.com", { method: "POST", body: "secret" }), original);
});
