import { describe, expect, it } from "vitest";

import { buildHomePageResponse } from "#internal/nitro/routes/index.js";

function buildResponseForRequest(url: string, headers?: Record<string, string>): Response {
  return buildHomePageResponse(new Request(url, { headers }));
}

describe("buildHomePageResponse", () => {
  it("returns a barebones HTML response", () => {
    const response = buildResponseForRequest("https://my-agent.example.com/");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("links out to the public docs site", async () => {
    const body = await buildResponseForRequest("https://my-agent.example.com/").text();

    expect(body).toContain("https://eve.dev/docs");
  });

  it("echoes the deployment origin into the `eve dev` hint", async () => {
    const body = await buildResponseForRequest("https://my-agent.example.com/").text();

    expect(body).toContain("eve dev https://my-agent.example.com");
    expect(body).not.toContain("eve dev {{DEPLOYMENT_URL}}");
  });

  it("prefers x-forwarded-host / x-forwarded-proto over the raw request URL", async () => {
    // Vercel's edge forwards the public-facing host on these headers; the
    // raw `request.url` Nitro sees is the internal route target.
    const body = await buildResponseForRequest("http://0.0.0.0:3000/", {
      "x-forwarded-host": "agent.production.example",
      "x-forwarded-proto": "https",
    }).text();

    expect(body).toContain("eve dev https://agent.production.example");
    expect(body).not.toContain("0.0.0.0");
  });

  it("uses the leftmost hop from a comma-separated x-forwarded-host", async () => {
    const body = await buildResponseForRequest("http://0.0.0.0:3000/", {
      "x-forwarded-host": "public.example, internal-edge-1, internal-edge-2",
      "x-forwarded-proto": "https",
    }).text();

    expect(body).toContain("eve dev https://public.example");
    expect(body).not.toContain("internal-edge");
  });

  it("escapes HTML metacharacters from the host", async () => {
    const body = await buildResponseForRequest("http://localhost/", {
      "x-forwarded-host": '"><script>alert(1)</script>',
      "x-forwarded-proto": "https",
    }).text();

    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
  });

  it("does not leak any agent configuration", async () => {
    const body = await buildResponseForRequest("https://my-agent.example.com/").text();

    // The deployed URL is reachable by anonymous callers, so the response
    // must not advertise anything that ties this deployment to its
    // underlying agent (name, model, instructions text, API surface, etc.).
    expect(body).not.toMatch(/openai|anthropic|gpt|claude/i);
    expect(body).not.toMatch(/instructions/i);
    expect(body).not.toMatch(/\/eve\/v1\//);
    expect(body).not.toContain("__EVE_UI_AGENT_INFO_ONLY_MODE__");
  });

  it("loads no external assets and asks search engines to skip the page", async () => {
    const body = await buildResponseForRequest("https://my-agent.example.com/").text();

    expect(body).toContain('<meta name="robots" content="noindex">');
    expect(body).toContain('<meta name="referrer" content="no-referrer">');
    // No external fonts, scripts, or images — the deployment must not
    // leak its origin to a third party just by being visited.
    expect(body).not.toMatch(/<script[\s>]/i);
    expect(body).not.toMatch(/<img[\s>]/i);
    expect(body).not.toMatch(/<link[^>]+href=["']https?:/i);
    expect(body).not.toMatch(/@import|url\(https?:/i);
  });
});
