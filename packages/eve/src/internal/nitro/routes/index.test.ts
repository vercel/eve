import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { buildHomePageResponse } from "#internal/nitro/routes/index.js";

function buildResponseForRequest(url: string, headers?: Record<string, string>): Response {
  return buildHomePageResponse({ agentName: "support-agent" }, new Request(url, { headers }));
}

async function runCopyScript(
  body: string,
  options: { clipboard: "success" | "reject" | "missing"; fallbackCopies: boolean },
) {
  const script = body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  expect(script).toBeDefined();

  const commandText = body.match(/data-copy-command>(.*?)<\/span>/)?.[1];
  expect(commandText).toBeDefined();
  const command = { textContent: commandText ?? "" };
  const attributes = new Map([
    ["aria-label", "Copy command"],
    ["title", "Copy command"],
  ]);
  let click: (() => Promise<void>) | undefined;
  const copyButton = {
    hidden: true,
    dataset: {} as Record<string, string>,
    addEventListener: (_event: string, listener: () => Promise<void>) => {
      click = listener;
    },
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  };
  const copyStatus = { textContent: "" };
  const selection = { removeAllRanges: vi.fn(), addRange: vi.fn() };
  const selectNodeContents = vi.fn();
  const execCommand = vi.fn(() => options.fallbackCopies);
  const writeText = vi.fn(async () => {
    if (options.clipboard === "reject") {
      throw new Error("Clipboard permission denied");
    }
  });
  const navigator = options.clipboard === "missing" ? {} : { clipboard: { writeText } };

  runInNewContext(script ?? "", {
    clearTimeout: vi.fn(),
    document: {
      createRange: () => ({ selectNodeContents }),
      execCommand,
      querySelector: (selector: string) => {
        if (selector === "[data-copy-command]") return command;
        if (selector === "[data-copy-button]") return copyButton;
        if (selector === "[data-copy-status]") return copyStatus;
        throw new Error(`Unexpected selector: ${selector}`);
      },
    },
    navigator,
    setTimeout: vi.fn(),
    window: { getSelection: () => selection },
  });

  expect(copyButton.hidden).toBe(false);
  expect(click).toBeDefined();
  await click?.();

  return {
    attributes,
    command,
    copyButton,
    copyStatus,
    execCommand,
    selectNodeContents,
    writeText,
  };
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

  it("renders the eve wordmark as an inline SVG", async () => {
    const body = await buildResponseForRequest("https://my-agent.example.com/").text();

    expect(body).toContain('<div class="brand" aria-label="eve">');
    expect(body).toContain('viewBox="0 0 169 53"');
    expect(body).not.toContain('<h1 class="mono">eve</h1>');
  });

  it("renders and escapes the baked-in agent name", async () => {
    const response = buildHomePageResponse(
      { agentName: 'support"><script>alert(1)</script>' },
      new Request("https://my-agent.example.com/"),
    );
    const body = await response.text();

    expect(body).toContain("support&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).not.toContain("<script>alert(1)</script>");
  });

  it("renders a dollar-containing agent name literally", async () => {
    const response = buildHomePageResponse(
      { agentName: "support-$&-agent" },
      new Request("https://my-agent.example.com/", {
        headers: {
          "x-forwarded-host": "agent.example",
          "x-forwarded-proto": "https",
        },
      }),
    );
    const body = await response.text();

    expect(body).toContain("support-$&amp;-agent");
    expect(body).toContain('eve dev "https://agent.example"');
    expect(body).not.toContain("{{AGENT_NAME}}");
    expect(body).not.toContain("{{DEPLOYMENT_URL}}");
  });

  it("echoes the deployment origin into the `eve dev` hint", async () => {
    const body = await buildResponseForRequest("https://my-agent.example.com/").text();

    expect(body).toContain('eve dev "https://my-agent.example.com"');
    expect(body).not.toContain("eve dev {{DEPLOYMENT_URL}}");
  });

  it("renders an accessible control for copying the `eve dev` command", async () => {
    const body = await buildResponseForRequest("https://my-agent.example.com/").text();

    expect(body).toContain('data-copy-command>eve dev "https://my-agent.example.com"</span>');
    expect(body).toContain('type="button" aria-label="Copy command"');
  });

  it.each([
    { clipboard: "success" as const, fallbackCopies: false, expectedCopied: true },
    { clipboard: "reject" as const, fallbackCopies: true, expectedCopied: true },
    { clipboard: "missing" as const, fallbackCopies: true, expectedCopied: true },
    { clipboard: "missing" as const, fallbackCopies: false, expectedCopied: false },
  ])(
    "handles clipboard=$clipboard with fallbackCopies=$fallbackCopies",
    async ({ clipboard, fallbackCopies, expectedCopied }) => {
      const body = await buildResponseForRequest("https://my-agent.example.com/").text();
      const result = await runCopyScript(body, { clipboard, fallbackCopies });

      expect(result.attributes.get("aria-label")).toBe("Copy command");
      expect(result.copyButton.dataset.copied === "true").toBe(expectedCopied);
      expect(result.copyStatus.textContent).toBe(
        expectedCopied ? "Command copied" : "Could not copy command",
      );
      expect(result.writeText).toHaveBeenCalledTimes(clipboard === "missing" ? 0 : 1);
      if (clipboard !== "missing") {
        expect(result.writeText).toHaveBeenCalledWith('eve dev "https://my-agent.example.com"');
      }
      expect(result.execCommand).toHaveBeenCalledTimes(clipboard === "success" ? 0 : 1);
      expect(result.selectNodeContents).toHaveBeenCalledTimes(clipboard === "success" ? 0 : 1);
      if (clipboard !== "success") {
        expect(result.selectNodeContents).toHaveBeenCalledWith(result.command);
      }
    },
  );

  it("prefers x-forwarded-host / x-forwarded-proto over the raw request URL", async () => {
    // Vercel's edge forwards the public-facing host on these headers; the
    // raw `request.url` Nitro sees is the internal route target.
    const body = await buildResponseForRequest("http://0.0.0.0:3000/", {
      "x-forwarded-host": "agent.production.example",
      "x-forwarded-proto": "https",
    }).text();

    expect(body).toContain('eve dev "https://agent.production.example"');
    expect(body).not.toContain("0.0.0.0");
  });

  it("uses x-forwarded-proto with a preserved public host header", async () => {
    const body = await buildResponseForRequest("http://0.0.0.0:3000/", {
      host: "agent.production.example",
      "x-forwarded-proto": "https",
    }).text();

    expect(body).toContain('eve dev "https://agent.production.example"');
    expect(body).not.toContain("0.0.0.0");
  });

  it("uses the leftmost hop from a comma-separated x-forwarded-host", async () => {
    const body = await buildResponseForRequest("http://0.0.0.0:3000/", {
      "x-forwarded-host": "public.example, internal-edge-1, internal-edge-2",
      "x-forwarded-proto": "https",
    }).text();

    expect(body).toContain('eve dev "https://public.example"');
    expect(body).not.toContain("internal-edge");
  });

  it.each([
    "safe.example&printf PWNED",
    "safe.example;printf",
    "safe.example$(printf)",
    "safe.example`printf`",
  ])("rejects forwarded host %s that could add shell commands", async (host) => {
    const body = await buildResponseForRequest("http://localhost/", {
      "x-forwarded-host": host,
      "x-forwarded-proto": "https",
    }).text();

    expect(body).toContain('eve dev "http://localhost"');
    expect(body).not.toContain("safe.example");
  });

  it("quotes an IPv6 deployment origin for shell compatibility", async () => {
    const body = await buildResponseForRequest("http://[::1]:3000/").text();

    expect(body).toContain('eve dev "http://[::1]:3000"');
  });

  it("rejects shell syntax encoded in the raw request host", async () => {
    const request = {
      headers: new Headers(),
      url: "https://safe.example%27%24%28printf%20PWNED%29%27/",
    } as Request;
    const body = await buildHomePageResponse({ agentName: "support-agent" }, request).text();

    expect(body).toContain('eve dev "http://localhost"');
    expect(body).not.toContain("printf PWNED");
  });

  it("does not leak any agent configuration", async () => {
    const body = await buildResponseForRequest("https://my-agent.example.com/").text();

    // The deployed URL is reachable by anonymous callers, so the response
    // must not advertise model/provider details, instructions text, or the
    // authenticated eve API surface.
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
    // leak its origin to a third party just by being visited. The copy
    // control uses one inline script and makes no network requests.
    expect(body.match(/<script[\s>]/gi)).toHaveLength(1);
    expect(body).not.toMatch(/<script[^>]+src=/i);
    expect(body).not.toMatch(/<img[\s>]/i);
    expect(body).not.toMatch(/<link[^>]+href=["']https?:/i);
    expect(body).not.toMatch(/@import|url\(https?:/i);
  });
});
