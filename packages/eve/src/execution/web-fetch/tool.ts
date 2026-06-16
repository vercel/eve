import { EVE_PACKAGE_NAME } from "#internal/package-name.js";
import { truncateHead } from "#execution/sandbox/truncate-output.js";
import { convertHtmlToMarkdown, extractTextFromHtml } from "#execution/web-fetch/html.js";

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5 MB
const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds
const MAX_TIMEOUT_MS = 120_000; // 2 minutes

/**
 * Browser-like User-Agent used for the initial request so servers return
 * full-fidelity content rather than bot-degraded pages.
 */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

type Format = "html" | "markdown" | "text";

/**
 * Typed input accepted by {@link executeWebFetchTool}.
 */
export interface WebFetchInput {
  readonly format?: Format;
  readonly timeout?: number;
  readonly url: string;
}

/**
 * Structured result returned from {@link executeWebFetchTool}.
 */
export interface WebFetchResult {
  /** Response body, bounded to the shared tool-output limits. */
  readonly content: string;
  /** Response `Content-Type` header. */
  readonly contentType: string;
  /** Fetched URL. */
  readonly url: string;
  /** True when {@link content} was shortened to fit the output budget. */
  readonly truncated: boolean;
}

/**
 * Executes the `web_fetch` framework tool.
 *
 * Fetches the content at the given URL and returns it in the requested
 * format. HTML responses are automatically converted to Markdown or
 * plain text when the caller requests those formats. Responses up to
 * 5 MB are accepted, and the returned {@link WebFetchResult.content}
 * is capped at the shared tool-output budget (50 KB / 2000 lines) so
 * large pages do not exhaust the model's context window.
 */
export async function executeWebFetchTool(args: WebFetchInput): Promise<WebFetchResult> {
  const { url, format = "markdown", timeout } = args;

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error("URL must start with http:// or https://");
  }

  const timeoutMs = Math.min(
    timeout !== undefined ? timeout * 1000 : DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );

  const signal = AbortSignal.timeout(timeoutMs);
  const headers = buildHeaders(format);

  const initial = await fetch(url, { headers, signal });

  // Cloudflare may reject browser-like UA strings from Node.js runtimes
  // because the TLS fingerprint does not match a real browser. Retry with
  // an honest UA to bypass the challenge.
  const response =
    initial.status === 403 && initial.headers.get("cf-mitigated") === "challenge"
      ? await fetch(url, {
          headers: { ...headers, "User-Agent": EVE_PACKAGE_NAME },
          signal,
        })
      : initial;

  if (!response.ok) {
    throw new Error(`Request failed with status code: ${response.status}`);
  }

  const declaredLength = response.headers.get("content-length");

  if (declaredLength !== null && parseInt(declaredLength, 10) > MAX_RESPONSE_SIZE) {
    throw new Error("Response too large (exceeds 5 MB limit).");
  }

  const buffer = await response.arrayBuffer();

  if (buffer.byteLength > MAX_RESPONSE_SIZE) {
    throw new Error("Response too large (exceeds 5 MB limit).");
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isHtml = contentType.includes("text/html");
  const body = new TextDecoder().decode(buffer);

  let rawContent: string;

  if (format === "markdown" && isHtml) {
    rawContent = convertHtmlToMarkdown(body);
  } else if (format === "text" && isHtml) {
    rawContent = extractTextFromHtml(body);
  } else {
    rawContent = body;
  }

  const { output: content, truncated } = truncateHead(rawContent);

  return {
    content,
    contentType,
    truncated,
    url,
  };
}

function buildHeaders(format: Format): Record<string, string> {
  let accept: string;

  if (format === "markdown") {
    accept =
      "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
  } else if (format === "text") {
    accept = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
  } else {
    accept =
      "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
  }

  return {
    Accept: accept,
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": BROWSER_USER_AGENT,
  };
}
