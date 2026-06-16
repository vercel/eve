import { afterEach, describe, expect, it, vi } from "vitest";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from "#execution/sandbox/truncate-output.js";
import { convertHtmlToMarkdown, extractTextFromHtml } from "#execution/web-fetch/html.js";
import { executeWebFetchTool } from "#execution/web-fetch/tool.js";

describe("convertHtmlToMarkdown", () => {
  it("converts headings to ATX-style markdown", () => {
    const html = "<h1>Title</h1><h2>Subtitle</h2><p>Body text.</p>";
    const markdown = convertHtmlToMarkdown(html);

    expect(markdown).toContain("# Title");
    expect(markdown).toContain("## Subtitle");
    expect(markdown).toContain("Body text.");
  });

  it("converts links to markdown syntax", () => {
    const html = '<a href="https://example.com">Example</a>';
    const markdown = convertHtmlToMarkdown(html);

    expect(markdown).toContain("[Example](https://example.com)");
  });

  it("removes script, style, meta, and link elements", () => {
    const html = [
      "<html><head>",
      '<meta charset="utf-8">',
      '<link rel="stylesheet" href="style.css">',
      "<style>body { color: red; }</style>",
      "</head><body>",
      "<script>alert('xss')</script>",
      "<p>Visible content.</p>",
      "</body></html>",
    ].join("");
    const markdown = convertHtmlToMarkdown(html);

    expect(markdown).toContain("Visible content.");
    expect(markdown).not.toContain("alert");
    expect(markdown).not.toContain("color: red");
    expect(markdown).not.toContain("stylesheet");
  });

  it("converts unordered lists with dash markers", () => {
    const html = "<ul><li>One</li><li>Two</li></ul>";
    const markdown = convertHtmlToMarkdown(html);

    expect(markdown).toMatch(/-\s+One/);
    expect(markdown).toMatch(/-\s+Two/);
  });

  it("converts fenced code blocks", () => {
    const html = "<pre><code>const x = 1;</code></pre>";
    const markdown = convertHtmlToMarkdown(html);

    expect(markdown).toContain("```");
    expect(markdown).toContain("const x = 1;");
  });
});

describe("extractTextFromHtml", () => {
  it("strips all HTML tags and returns plain text", () => {
    const html = "<h1>Title</h1><p>Body <strong>bold</strong> text.</p>";
    const text = extractTextFromHtml(html);

    expect(text).toContain("Title");
    expect(text).toContain("Body bold text.");
    expect(text).not.toContain("<");
  });

  it("removes script and style content entirely", () => {
    const html = [
      "<p>Before</p>",
      "<script>var x = 1;</script>",
      "<style>.a { color: red; }</style>",
      "<noscript>Enable JS</noscript>",
      "<p>After</p>",
    ].join("");
    const text = extractTextFromHtml(html);

    expect(text).toContain("Before");
    expect(text).toContain("After");
    expect(text).not.toContain("var x");
    expect(text).not.toContain("color: red");
    expect(text).not.toContain("Enable JS");
  });

  it("decodes common HTML entities", () => {
    const html = "<p>A &amp; B &lt; C &gt; D &quot;E&quot; &#39;F&#39;</p>";
    const text = extractTextFromHtml(html);

    expect(text).toBe("A & B < C > D \"E\" 'F'");
  });

  it("converts block-level tags into newlines", () => {
    const html = "<div>Line 1</div><div>Line 2</div>";
    const text = extractTextFromHtml(html);

    expect(text).toContain("Line 1\nLine 2");
  });
});

describe("executeWebFetchTool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects URLs that do not start with http:// or https://", async () => {
    await expect(executeWebFetchTool({ url: "ftp://example.com" })).rejects.toThrow(
      "URL must start with http:// or https://",
    );

    await expect(executeWebFetchTool({ url: "file:///etc/passwd" })).rejects.toThrow(
      "URL must start with http:// or https://",
    );
  });

  it("fetches a URL and returns content in the default markdown format", async () => {
    const html = "<html><body><h1>Hello</h1><p>World</p></body></html>";

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
        status: 200,
      }),
    );

    const result = (await executeWebFetchTool({
      url: "https://example.com",
    })) as { content: string; contentType: string; url: string };

    expect(result.url).toBe("https://example.com");
    expect(result.contentType).toContain("text/html");
    expect(result.content).toContain("# Hello");
    expect(result.content).toContain("World");
  });

  it("returns raw HTML when format is html", async () => {
    const html = "<html><body><h1>Hello</h1></body></html>";

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(html, {
        headers: { "Content-Type": "text/html" },
        status: 200,
      }),
    );

    const result = (await executeWebFetchTool({
      format: "html",
      url: "https://example.com",
    })) as { content: string };

    expect(result.content).toBe(html);
  });

  it("extracts plain text from HTML when format is text", async () => {
    const html = "<html><body><script>evil()</script><h1>Title</h1><p>Body text.</p></body></html>";

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(html, {
        headers: { "Content-Type": "text/html" },
        status: 200,
      }),
    );

    const result = (await executeWebFetchTool({
      format: "text",
      url: "https://example.com",
    })) as { content: string };

    expect(result.content).toContain("Title");
    expect(result.content).toContain("Body text.");
    expect(result.content).not.toContain("evil");
  });

  it("returns non-HTML content as-is regardless of format", async () => {
    const json = '{"key": "value"}';

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(json, {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );

    const result = (await executeWebFetchTool({
      url: "https://api.example.com/data",
    })) as { content: string };

    expect(result.content).toBe(json);
  });

  it("throws on non-ok responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

    await expect(executeWebFetchTool({ url: "https://example.com/missing" })).rejects.toThrow(
      "Request failed with status code: 404",
    );
  });

  it("throws when Content-Length exceeds the 5 MB limit", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", {
        headers: { "Content-Length": String(6 * 1024 * 1024) },
        status: 200,
      }),
    );

    await expect(executeWebFetchTool({ url: "https://example.com/large" })).rejects.toThrow(
      "Response too large",
    );
  });

  it("retries with honest user-agent on Cloudflare challenge", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    fetchSpy.mockResolvedValueOnce(
      new Response("Blocked", {
        headers: { "cf-mitigated": "challenge" },
        status: 403,
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response("OK content", {
        headers: { "Content-Type": "text/plain" },
        status: 200,
      }),
    );

    const result = (await executeWebFetchTool({
      url: "https://example.com",
    })) as { content: string };

    expect(result.content).toBe("OK content");
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const retryCall = fetchSpy.mock.calls[1];
    expect(retryCall).toBeDefined();
    const retryHeaders = (retryCall![1] as RequestInit).headers as Record<string, string>;

    expect(retryHeaders["User-Agent"]).toBe(EVE_PACKAGE_NAME);
  });

  it("sends format-aware Accept headers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    fetchSpy.mockResolvedValueOnce(
      new Response("content", {
        headers: { "Content-Type": "text/plain" },
        status: 200,
      }),
    );

    await executeWebFetchTool({
      format: "markdown",
      url: "https://example.com",
    });

    const firstCall = fetchSpy.mock.calls[0];
    expect(firstCall).toBeDefined();
    const headers = (firstCall![1] as RequestInit).headers as Record<string, string>;

    expect(headers.Accept).toContain("text/markdown");
  });

  it("truncates large bodies to the shared tool-output budget", async () => {
    const huge = "line of content\n".repeat(MAX_OUTPUT_LINES + 500);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(huge, {
        headers: { "Content-Type": "text/plain" },
        status: 200,
      }),
    );

    const result = await executeWebFetchTool({
      format: "text",
      url: "https://example.com",
    });

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(result.content.split("\n").length).toBeLessThanOrEqual(MAX_OUTPUT_LINES + 5);
  });
});
