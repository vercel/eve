import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function requestEvidence(body, headers) {
  const { prompt, ...parameters } = JSON.parse(body);
  if (!Array.isArray(prompt) || prompt.length > 256)
    throw new Error("Unexpected diagnostic prompt.");
  return {
    model: headers.get("ai-language-model-id"),
    parameters: hash(parameters),
    autoCaching: parameters.providerOptions?.gateway?.caching === "auto",
    fields: Object.fromEntries(
      Object.entries(parameters).map(([key, value]) => [key, hash(value)]),
    ),
    messages: prompt.map((message) => ({
      role: message.role,
      hash: hash(message),
      parts: Array.isArray(message.content)
        ? message.content.map((part) => ({ type: part.type, hash: hash(part) }))
        : [],
    })),
  };
}

export function responseEvidence(part) {
  if (part.type === "response-metadata") return { type: part.type, responseId: part.id };
  if (part.type !== "finish") return undefined;
  const gateway = part.providerMetadata?.gateway ?? {};
  // Metadata is open-ended and can contain secrets. Only copy known accounting fields.
  return {
    type: part.type,
    finishReason: part.finishReason?.unified,
    usage: Object.fromEntries(
      ["inputTokens", "outputTokens"].map((kind) => [
        kind,
        Object.fromEntries(
          ["total", "noCache", "cacheRead", "cacheWrite", "text", "reasoning"]
            .filter((key) => typeof part.usage?.[kind]?.[key] === "number")
            .map((key) => [key, part.usage[kind][key]]),
        ),
      ]),
    ),
    generationId: gateway.generationId,
    metadataKeys: Object.keys(gateway),
    routingFields: Object.fromEntries(
      Object.entries(gateway.routing ?? {}).map(([key, value]) => [key, hash(value)]),
    ),
  };
}

export function captureFetch(fetch, record) {
  let count = 0;
  return async function (input, init) {
    const url = new URL(input instanceof Request ? input.url : input);
    if (
      url.hostname !== "ai-gateway.vercel.sh" ||
      !url.pathname.endsWith("/language-model") ||
      typeof init?.body !== "string" ||
      Buffer.byteLength(init.body) > 2_000_000 ||
      count++ >= 100
    )
      return fetch(input, init);
    const id = randomUUID();
    record({
      id,
      at: Date.now(),
      type: "request",
      ...requestEvidence(init.body, new Headers(init.headers)),
    });
    const response = await fetch(input, init);
    record({
      id,
      at: Date.now(),
      type: "headers",
      status: response.status,
      vercelId: response.headers.get("x-vercel-id"),
    });
    if (
      response.body === null ||
      !response.headers.get("content-type")?.includes("text/event-stream")
    )
      return response;
    const decoder = new TextDecoder();
    let pending = "";
    let observedBytes = 0;
    return new Response(
      response.body.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            controller.enqueue(chunk);
            observedBytes += chunk.byteLength;
            if (observedBytes > 4_000_000) return;
            pending += decoder.decode(chunk, { stream: true });
            if (pending.length > 256_000) {
              pending = "";
              record({ id, type: "capture-limit" });
              observedBytes = 4_000_001;
              return;
            }
            let end;
            while ((end = pending.indexOf("\n")) !== -1) {
              const line = pending.slice(0, end).trim();
              pending = pending.slice(end + 1);
              if (!line.startsWith("data:") || line === "data: [DONE]") continue;
              try {
                const evidence = responseEvidence(JSON.parse(line.slice(5)));
                if (evidence) record({ id, at: Date.now(), ...evidence });
              } catch {
                record({ id, type: "capture-parse-error" });
              }
            }
          },
        }),
      ),
      { status: response.status, statusText: response.statusText, headers: response.headers },
    );
  };
}

if (process.env.EVE_CACHE_CAPTURE_FILE) {
  const destination = process.env.EVE_CACHE_CAPTURE_FILE;
  globalThis.fetch = captureFetch(globalThis.fetch, (event) => {
    appendFileSync(destination, `${JSON.stringify(event)}\n`);
  });
}
