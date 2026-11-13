import { isIP } from "node:net";
import { z } from "zod";

const maxCharsTotal = 16_000;
const objective = z.string().trim().min(1).max(2_000);
const credentialParameter = /(?:^|[_-])auth(?:$|[_-])|authorization|authentication|oauth|token|password|secret|credential|signature|session|api.?key|key-pair-id|^(authcode|code|key|sig|jwt|otp|policy)$/i;
export const publicUrl = z.string().trim().max(2_048).transform((value) => value.split("#", 1)[0]).refine((value) => {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/\.$/, "");
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password &&
      !url.port && ![...url.searchParams.keys()].some((key) => credentialParameter.test(key)) &&
      !isIP(host.replace(/^\[|\]$/g, "")) && host.includes(".") &&
      !/(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host);
  } catch { return false; }
}, "Use a public HTTP(S) domain URL without credentials, token parameters, or a custom port.");

export const searchInput = z.object({
  objective,
  search_queries: z.array(z.string().trim().min(1).max(200)).min(1).max(3),
  max_results: z.number().int().min(1).max(10).default(5),
});
export const extractInput = z.object({ urls: z.array(publicUrl).min(1).max(5), objective });

const responseSchema = z.object({
  results: z.array(z.object({
    url: publicUrl.nullable().catch(null),
    title: z.string().nullish(),
    publish_date: z.string().nullish(),
    excerpts: z.array(z.string()),
  })),
  errors: z.array(z.object({
    url: publicUrl.nullable().catch(null),
    error_type: z.string(),
    http_status_code: z.number().int().nullish(),
  })).default([]),
  warnings: z.array(z.unknown()).nullish(),
});

type Options = { signal?: AbortSignal; fetch?: typeof fetch };

async function readResponse(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error();
  const content = Buffer.alloc(1_048_576);
  let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes + value.byteLength > content.length) throw new Error();
      content.set(value, bytes);
      bytes += value.byteLength;
    }
    signal.throwIfAborted();
    return responseSchema.parse(JSON.parse(content.toString("utf8", 0, bytes)));
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function request(
  endpoint: "search" | "extract",
  body: Record<string, unknown>,
  maxResults: number,
  maxCharsPerResult: number,
  options: Options,
) {
  const apiKey = process.env.PARALLEL_API_KEY?.trim();
  if (!apiKey) throw new Error("Public web research is unavailable. Set PARALLEL_API_KEY on the server.");
  const timeout = AbortSignal.timeout(30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`https://api.parallel.ai/v1/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
  } catch {
    signal.throwIfAborted();
    throw new Error("Parallel request failed. Check connectivity before retrying.");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
    const guidance = response.status === 401 || response.status === 403
      ? "Check the server API key and app permissions."
      : response.status === 429 ? "Rate or spend limit reached; do not retry immediately."
      : "Try another source or retry later.";
    throw new Error(`Parallel returned HTTP ${response.status}. ${guidance}`);
  }
  let data: z.infer<typeof responseSchema>;
  try {
    data = await readResponse(response, signal);
  } catch {
    signal.throwIfAborted();
    throw new Error("Parallel returned an invalid response.");
  }
  signal.throwIfAborted();
  const sources = data.results.filter((result): result is typeof result & { url: string } => result.url !== null);
  const errors = data.errors.filter((error): error is typeof error & { url: string } => error.url !== null);
  let remaining = maxCharsTotal;
  let truncated = data.results.length > maxResults || data.errors.length > maxResults ||
    sources.length < data.results.length || errors.length < data.errors.length;
  const results = sources.slice(0, maxResults).map((result) => {
    let budget = Math.min(remaining, maxCharsPerResult);
    const excerpts: string[] = [];
    for (const excerpt of result.excerpts) {
      const text = excerpt.slice(0, budget);
      if (text) excerpts.push(text);
      if (text.length < excerpt.length) truncated = true;
      budget -= text.length;
      remaining -= text.length;
    }
    return {
      url: result.url,
      title: result.title?.slice(0, 500) ?? null,
      publish_date: result.publish_date?.slice(0, 32) ?? null,
      excerpts,
    };
  });
  return {
    provider: "parallel",
    retrieved_at: new Date().toISOString(),
    results,
    errors: errors.slice(0, maxResults).map((error) => ({
      url: error.url,
      error_type: error.error_type.slice(0, 100),
      http_status_code: error.http_status_code ?? null,
    })),
    warning_count: data.warnings?.length ?? 0,
    truncated,
  };
}

export function searchWeb(input: z.input<typeof searchInput>, options: Options = {}) {
  const { max_results, ...query } = searchInput.parse(input);
  return request("search", {
    ...query,
    mode: "fast",
    max_chars_total: maxCharsTotal,
    advanced_settings: { max_results, excerpt_settings: { max_chars_per_result: 2_000 } },
  }, max_results, 2_000, options);
}

export function extractWeb(input: z.input<typeof extractInput>, options: Options = {}) {
  const parsed = extractInput.parse(input);
  const urls = [...new Set(parsed.urls)];
  return request("extract", {
    ...parsed,
    urls,
    max_chars_total: maxCharsTotal,
    advanced_settings: { full_content: false, fetch_policy: { timeout_seconds: 20 }, excerpt_settings: { max_chars_per_result: 6_000 } },
  }, urls.length, 6_000, options);
}
