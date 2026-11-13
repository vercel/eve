import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import search from "../agent/tools/web_search";
import extract from "../agent/tools/web_fetch";
import { extractWeb, searchWeb } from "../server/parallel";

const query = { objective: "Find official product documentation", search_queries: ["official product docs"] };
const source = { url: "https://example.com/docs", title: "Documentation", publish_date: "2026-10-28", excerpts: ["Public evidence"] };
const reply = (value: unknown = { results: [source] }) => vi.fn<typeof fetch>(async () => Response.json(value));

beforeEach(() => vi.stubEnv("PARALLEL_API_KEY", "test-server-key"));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Parallel public research", () => {
  it("sends bounded v1 search requests and retains citable evidence without provider metadata", async () => {
    const fetcher = reply({ results: [source], session_id: "provider-private-id", usage: [{ count: 1 }] });
    const output = await searchWeb(query, { fetch: fetcher });
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.parallel.ai/v1/search");
    expect(options).toMatchObject({ method: "POST", redirect: "error", headers: { "x-api-key": "test-server-key" } });
    expect(JSON.parse(options!.body as string)).toEqual({
      ...query, mode: "fast", max_chars_total: 16_000,
      advanced_settings: { max_results: 5, excerpt_settings: { max_chars_per_result: 2_000 } },
    });
    expect(output).toMatchObject({ results: [source], errors: [], truncated: false, warning_count: 0 });
    expect(JSON.stringify(output)).not.toMatch(/test-server-key|provider-private-id|usage/);
  });

  it("deduplicates extract URLs, nests v1 settings, and reports partial failure without error content", async () => {
    const failed = "https://example.com/unavailable";
    const fetcher = reply({ results: [source], errors: [{ url: failed, error_type: "fetch_error", http_status_code: 403, content: "private diagnostic" }], warnings: [{ detail: "private diagnostic" }] });
    const output = await extractWeb({ objective: query.objective, urls: [source.url, failed, source.url] }, { fetch: fetcher });
    expect(fetcher.mock.calls[0][0]).toBe("https://api.parallel.ai/v1/extract");
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({
      objective: query.objective, urls: [source.url, failed], max_chars_total: 16_000,
      advanced_settings: { full_content: false, fetch_policy: { timeout_seconds: 20 }, excerpt_settings: { max_chars_per_result: 6_000 } },
    });
    expect(output).toMatchObject({ results: [source], errors: [{ url: failed, error_type: "fetch_error", http_status_code: 403 }], warning_count: 1 });
    expect(JSON.stringify(output)).not.toContain("private diagnostic");
  });

  it("preserves public author query parameters in search and extraction", async () => {
    const result = { ...source, url: source.url + "?author=2&author_name=example" };
    const fetcher = reply({ results: [result] });
    expect((await searchWeb(query, { fetch: fetcher })).results).toEqual([result]);
    expect((await extractWeb({ urls: [result.url], objective: query.objective }, { fetch: fetcher })).results).toEqual([result]);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).urls).toEqual([result.url]);
  });

  it("keeps usable sources and errors when other returned URLs are excluded", async () => {
    const error = { url: source.url + "/missing", error_type: "fetch_error", http_status_code: 404 };
    const output = await searchWeb(query, { fetch: reply({
      results: [{ ...source, url: source.url + "?access_token=private" }, source],
      errors: [{ ...error, url: "http://localhost" }, error],
    }) });
    expect(output).toMatchObject({ results: [source], errors: [error], truncated: true });
    expect(JSON.stringify(output)).not.toMatch(/private|localhost/);
  });

  it("returns partial extraction results before the client deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), milliseconds);
      return controller.signal;
    });
    const error = { url: source.url + "/slow", error_type: "timeout" };
    try {
      const outcome = extractWeb({ urls: [source.url, error.url], objective: query.objective }, {
        fetch: async (_url, options) => {
          const body = z.object({ advanced_settings: z.object({ fetch_policy: z.object({ timeout_seconds: z.number() }).optional() }) }).parse(JSON.parse(String(options?.body)));
          return new Promise<Response>((resolve, reject) => {
            const onAbort = () => { clearTimeout(timer); reject(options?.signal?.reason); };
            const timer = setTimeout(() => {
              options?.signal?.removeEventListener("abort", onAbort);
              resolve(Response.json({ results: [source], errors: [error] }));
            }, (body.advanced_settings.fetch_policy?.timeout_seconds ?? 60) * 1_000 + 1_000);
            options?.signal?.addEventListener("abort", onAbort, { once: true });
          });
        },
      }).then(output => ({ output }), (error: unknown) => ({ error }));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await outcome).toMatchObject({ output: { results: [source], errors: [error] } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces count, per-source and total excerpt limits even when the provider ignores them", async () => {
    const results = Array.from({ length: 12 }, (_, i) => ({ ...source, url: `https://example.com/${i}`, excerpts: ["a".repeat(1_500), "b".repeat(3_000)] }));
    const output = await searchWeb({ ...query, max_results: 10 }, { fetch: reply({ results }) });
    expect(output.results).toHaveLength(10);
    expect(output.truncated).toBe(true);
    expect(output.results.every((r) => r.excerpts.join("").length <= 2_000)).toBe(true);
    expect(output.results.flatMap((r) => r.excerpts).join("")).toHaveLength(16_000);
    const extracted = await extractWeb({ objective: query.objective, urls: [source.url] }, { fetch: reply({ results: [{ ...source, excerpts: ["a".repeat(8_000)] }] }) });
    expect(extracted.results[0].excerpts.join("")).toHaveLength(6_000);
    expect(extracted.truncated).toBe(true);
  });

  it.each(["file:///etc/passwd", "http://localhost", "https://service.internal", "https://a.local.", "https://127.0.0.1", "https://0x7f000001", "https://[::1]", "https://[::ffff:127.0.0.1]", "https://user:secret@example.com", "https://example.com:8443"])("rejects nonpublic or credential-bearing URL %s before a request", (url) => {
    const fetcher = reply();
    expect(() => extractWeb({ urls: [url], objective: query.objective }, { fetch: fetcher })).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("validates empty and excessive inputs before a request", () => {
    const fetcher = reply();
    for (const input of [{ ...query, objective: " " }, { ...query, search_queries: [] }, { ...query, max_results: 11 }])
      expect(() => searchWeb(input, { fetch: fetcher })).toThrow();
    expect(() => extractWeb({ objective: query.objective, urls: Array(6).fill(source.url) }, { fetch: fetcher })).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["?access_token=private", "?X-Amz-Signature=private", "?X-Goog-Credential=private", "?sig=private", "?api%5Fkey=private", "?auth=private", "?authorization=private", "?auth_code=private"])("rejects credential-bearing URL suffix %s before transmission", (suffix) => {
    const fetcher = reply();
    expect(() => extractWeb({ urls: [source.url + suffix], objective: query.objective }, { fetch: fetcher })).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("removes fragments from submitted and returned URLs without rejecting public page anchors", async () => {
    const fetcher = reply({ results: [{ ...source, url: source.url + "#overview" }] });
    const output = await extractWeb({ urls: [source.url + "#access_token=private"], objective: query.objective }, { fetch: fetcher });
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string).urls).toEqual([source.url]);
    expect(output.results[0].url).toBe(source.url);
    expect(JSON.stringify(output)).not.toContain("private");
  });

  it("cancels an oversized chunked response before parsing it", async () => {
    const cancel = vi.fn();
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { if (++chunks > 8) controller.close(); else controller.enqueue(new Uint8Array(256 * 1_024)); }, cancel,
    });
    await expect(searchWeb(query, { fetch: async () => new Response(body) })).rejects.toThrow("Parallel returned an invalid response");
    expect(cancel).toHaveBeenCalledOnce();
    expect(chunks).toBeLessThanOrEqual(6);
  });

  it("preserves public query strings and UTF-8 across response chunks", async () => {
    const url = "https://example.com/docs?q=public+research&page=2";
    const result = { ...source, url, excerpts: ["café 東京"] };
    const bytes = new TextEncoder().encode(JSON.stringify({ results: [result] }));
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } });
    expect((await extractWeb({ urls: [url], objective: query.objective }, { fetch: async () => new Response(body) })).results).toEqual([result]);
  });

  it("does not disclose errors while discarding provider error bodies", async () => {
    const body = new ReadableStream({ cancel() { throw new Error("private diagnostic"); } });
    await expect(searchWeb(query, { fetch: async () => new Response(body, { status: 401 }) })).rejects.toThrow(/^Parallel returned HTTP 401\. Check the server API key and app permissions\.$/);
  });

  it("fails clearly without a key and never contacts the provider", async () => {
    vi.stubEnv("PARALLEL_API_KEY", " ");
    const fetcher = reply();
    await expect(searchWeb(query, { fetch: fetcher })).rejects.toThrow("Set PARALLEL_API_KEY on the server");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500, 502, 503, 504])("sanitizes HTTP %i without retrying", async (status) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("private provider diagnostic", { status }));
    await expect(searchWeb(query, { fetch: fetcher })).rejects.toThrow(`Parallel returned HTTP ${status}.`);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("sanitizes transport and malformed response errors", async () => {
    await expect(searchWeb(query, { fetch: async () => { throw new Error("private transport diagnostic"); } })).rejects.toThrow(/^Parallel request failed\./);
    for (const value of [{ results: null }, { results: [{ ...source, excerpts: 5 }] }])
      await expect(searchWeb(query, { fetch: reply(value) })).rejects.toThrow(/^Parallel returned an invalid response\.$/);
    await expect(searchWeb(query, { fetch: async () => new Response("not json") })).rejects.toThrow(/^Parallel returned an invalid response\.$/);
  });

  it("preserves empty search and complete extraction failure as explicit results", async () => {
    expect((await searchWeb(query, { fetch: reply({ results: [] }) })).results).toEqual([]);
    const errors = [{ url: source.url, error_type: "fetch_error", http_status_code: 404 }];
    expect(await extractWeb({ objective: query.objective, urls: [source.url] }, { fetch: reply({ results: [], errors }) })).toMatchObject({ results: [], errors });
  });

  it.each(["disconnect", "truncated"])("rejects a %s response without returning partial evidence or retrying", async (failure) => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode('{"results":[')); } });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body));
    const pending = expect(searchWeb(query, { fetch: fetcher })).rejects.toThrow(/^Parallel returned an invalid response\.$/);
    await vi.waitFor(() => expect(body.locked).toBe(true));
    if (failure === "disconnect") stream.error(new Error("private upstream diagnostic")); else stream.close();
    await pending;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it.each(["AbortError", "TimeoutError"])("cancels a stalled response reader on %s without leaking the lock", async (name) => {
    const controller = new AbortController(), cancel = vi.fn();
    if (name === "TimeoutError") vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const body = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(new TextEncoder().encode('{"results":[')); }, cancel });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body));
    const outcome = searchWeb(query, { fetch: fetcher, signal: name === "AbortError" ? controller.signal : undefined }).catch(error => error);
    await vi.waitFor(() => expect(body.locked).toBe(true));
    controller.abort(new DOMException("Research interrupted", name));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce(), { timeout: 300 });
    expect(await outcome).toMatchObject({ name });
    expect(body.locked).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("isolates concurrent research results and cancellation between conversations", async () => {
    const first = new AbortController(), second = new AbortController();
    const abortedBody = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(new TextEncoder().encode('{"results":[')); } });
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      return body.objective === "First conversation" ? new Response(abortedBody) : Response.json({ results: [{ ...source, title: "Second conversation", excerpts: ["Second conversation evidence"] }] });
    });
    const canceled = searchWeb({ ...query, objective: "First conversation" }, { fetch: fetcher, signal: first.signal }).catch(error => error);
    const successful = searchWeb({ ...query, objective: "Second conversation" }, { fetch: fetcher, signal: second.signal });
    await vi.waitFor(() => expect(abortedBody.locked).toBe(true));
    first.abort();
    expect(await canceled).toMatchObject({ name: "AbortError" });
    expect(await successful).toMatchObject({ results: [{ title: "Second conversation", excerpts: ["Second conversation evidence"] }] });
    expect(second.signal.aborted).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("stops before fetch when cancelled and aborts in-flight requests on the 30-second deadline", async () => {
    const fetcher = reply();
    await expect(searchWeb(query, { fetch: fetcher, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const pending = searchWeb(query, { fetch: (_url, options) => new Promise((_, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
    }) });
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    deadline.abort(new DOMException("Request timed out", "TimeoutError"));
    await rejected;
    expect(timeout).toHaveBeenCalledWith(30_000);
  });

  it("passes Eve cancellation into both tools and returns the same source data to the model", async () => {
    const controller = new AbortController();
    const fetcher = reply();
    vi.stubGlobal("fetch", fetcher);
    const ctx = { abortSignal: controller.signal } as never;
    const output = await search.execute({ ...query, max_results: 5 }, ctx);
    if (!("results" in output)) throw new Error("Expected a completed search result");
    expect(search.toModelOutput!(output)).toEqual({ type: "json", value: output });
    controller.abort();
    expect(fetcher.mock.calls[0][1]!.signal!.aborted).toBe(true);
    await expect(extract.execute({ urls: [source.url], objective: query.objective }, ctx)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
