import { describe, expect, it } from "vitest";

import { type DisplayBlock, renderBlockLines } from "./blocks.js";
import { maxVisibleToolGroupItems } from "./tool-rows.js";
import { stripAnsi, visibleLength } from "#cli/ui/terminal-text.js";
import { createTheme } from "./theme.js";

const theme = createTheme({ color: false, unicode: true });
const ctx = { activityPulse: "▪" };

function render(block: DisplayBlock, width = 60): string[] {
  return renderBlockLines(block, width, theme, ctx).map(stripAnsi);
}

describe("renderBlockLines", () => {
  it("links every wrapped row of a connection-auth URL to the full URL", () => {
    const url = `https://auth.example.com/authorize?client_id=abc&redirect_uri=${"x".repeat(160)}`;
    const raw = renderBlockLines(
      {
        kind: "connection-auth",
        title: "Catalog · authorization · required",
        body: `Sign in to Catalog\nOpen to authorize:\n${url}`,
        link: url,
        preformatted: true,
      },
      100,
      theme,
      ctx,
    );
    const urlRows = raw.filter((row) => row.includes("\x1b]8;;"));
    expect(urlRows.length).toBeGreaterThan(1);
    for (const row of urlRows) {
      expect(row).toContain(`\x1b]8;;${url}\x1b\\`);
      expect(visibleLength(row)).toBeLessThanOrEqual(100);
    }
    expect(urlRows.map((row) => stripAnsi(row).trim()).join("")).toBe(url);
    expect(raw.map(stripAnsi)).toContain("  Open to authorize:");
  });
  it("colors only classified failures red, warnings yellow, and raw stderr neutral", () => {
    const colored = createTheme({ color: true, unicode: true });
    const body = (logLevel?: "error" | "warn") =>
      renderBlockLines(
        { kind: "log", title: "stderr", body: "message", logLevel },
        60,
        colored,
        ctx,
      ).join("\n");
    expect(body("error")).toContain(colored.colors.red("message"));
    expect(body("warn")).toContain(colored.colors.yellow("message"));
    expect(body()).toContain(colored.colors.gray("message"));
    expect(body()).not.toContain(colored.colors.red("message"));
  });
  it("renders a user message behind a left bar", () => {
    expect(render({ kind: "user", body: "hello there" })).toEqual(["│ hello there"]);
  });

  it("keeps a transient command invocation visible without a progress glyph", () => {
    const block = { kind: "command", body: "/help", live: true } as const;
    expect(renderBlockLines(block, 60, theme, { ...ctx, transientPanelOpen: true })).toEqual([
      "│ /help",
    ]);
    expect(renderBlockLines(block, 60, theme, ctx)).toEqual(["▪ /help"]);
  });

  it("marks rendered assistant Markdown with the brand triangle", () => {
    const lines = render({ kind: "assistant", body: "all done" });
    expect(lines).toEqual(["▲ all done"]);
  });

  it("keeps an inline image on the preceding prose row", () => {
    const lines = renderBlockLines(
      {
        kind: "assistant",
        body: "Visit [eve](https://github.com/vercel-labs/eve) or view this image: ![eve logo](https://eve.dev/logo.png).",
      },
      80,
      theme,
      ctx,
    );

    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0] ?? "")).toBe(
      "▲ Visit eve or view this image:\u00a0▧\u00a0eve\u00a0logo.",
    );

    const wrapped = renderBlockLines(
      {
        kind: "assistant",
        body: "Visit [eve](https://github.com/vercel-labs/eve) or view this image: ![eve logo](https://eve.dev/logo.png).",
      },
      35,
      theme,
      ctx,
    ).map(stripAnsi);
    expect(wrapped).toEqual(["▲ Visit eve or view this", "  image:\u00a0▧\u00a0eve\u00a0logo."]);
  });

  it("preserves prose Markdown when Markdown rendering is disabled", () => {
    const lines = renderBlockLines({ kind: "assistant", body: "**bold**\n\n- item" }, 60, theme, {
      ...ctx,
      renderMarkdown: false,
    }).map(stripAnsi);

    expect(lines).toEqual(["▲ **bold**", "  ", "  - item"]);
  });

  it("keeps per-item status markers monochrome in a mixed command result", () => {
    const colored = createTheme({ color: true, unicode: true });
    const lines = renderBlockLines(
      {
        kind: "result",
        body: "2 additions: 1 added, 1 failed\n\n  ✓ Web Chat\n    Installed.\n\n  ⨯ Slack\n    Installation failed.",
      },
      80,
      colored,
      ctx,
    );

    const output = lines.join("\n");
    expect(output).toContain("2 additions: 1 added, 1 failed");
    expect(output).not.toContain(colored.colors.gray("✓"));
    expect(output).not.toContain(colored.colors.red("⨯"));
    expect(output).not.toContain(colored.colors.green("✓"));
  });

  it("uses ASCII status markers when Unicode is unavailable", () => {
    const ascii = createTheme({ color: false, unicode: false });
    const lines = renderBlockLines(
      {
        kind: "result",
        body: "3 additions: 1 added, 1 failed, 1 cancelled\n\n  ✓ Web Chat\n\n  ⨯ Slack\n\n  – Notion",
      },
      80,
      ascii,
      ctx,
    );

    expect(lines.join("\n")).toContain("✓ Web Chat");
    expect(lines.join("\n")).toContain("⨯ Slack");
    expect(lines.join("\n")).toContain("– Notion");
  });

  it("summarizes a completed tool with a result line", () => {
    const lines = render({
      kind: "tool",
      title: "get_weather",
      subtitle: 'city="SF"',
      status: "done",
      result: "73°F",
    });
    expect(lines[0]).toBe('  ▪ get_weather  city="SF"');
    expect(lines[1]).toBe("   → 73°F");
  });

  it("swaps in the past-tense title once the call settles", () => {
    const running = render({
      kind: "tool",
      title: "Fetch https://one.example",
      doneTitle: "Fetched https://one.example",
      status: "running",
    });
    expect(running[0]).toBe("  ▪ Fetch https://one.example");

    const done = render({
      kind: "tool",
      title: "Fetch https://one.example",
      doneTitle: "Fetched https://one.example",
      status: "done",
    });
    expect(done).toEqual(["  ▪ Fetched https://one.example"]);
  });

  it("bolds only the leading verb of a tool header", () => {
    const colored = createTheme({ color: true, unicode: true });
    const [header] = renderBlockLines(
      { kind: "tool", title: "Ran find /workspace -maxdepth 3", status: "done" },
      80,
      colored,
      ctx,
    );
    // The verb closes bold before its argument begins; the argument is dim.
    expect(header).toContain("\x1b[1mRan\x1b[22m\x1b[2m find /workspace -maxdepth 3\x1b[22m");
  });

  it("shows the shared square pulse while a tool runs", () => {
    const lines = render({ kind: "tool", title: "search", status: "running", live: true });
    expect(lines[0]).toBe("  ▪ search");
  });

  it("renders a coalesced tool presentation as a railed item region", () => {
    const lines = render({
      kind: "tool",
      title: "Fetch 2 URLs",
      status: "running",
      toolGroupItems: [{ text: "https://two.example" }, { text: "https://one.example" }],
    });
    expect(lines).toEqual([
      "  ▪ Fetch 2 URLs",
      "  │ https://two.example",
      "  │ https://one.example",
      "  └",
    ]);
  });

  it("caps a coalesced batch's item list behind an elision line", () => {
    const lines = render({
      kind: "tool",
      title: "Fetch 30 URLs",
      status: "running",
      toolGroupItems: Array.from({ length: 30 }, (_, index) => ({
        text: `https://example.com/${index + 1}`,
      })),
    });
    expect(lines).toHaveLength(1 + maxVisibleToolGroupItems + 2);
    expect(lines[1]).toBe("  │ https://example.com/1");
    expect(lines[maxVisibleToolGroupItems]).toBe(
      `  │ https://example.com/${maxVisibleToolGroupItems}`,
    );
    expect(lines.at(-2)).toBe("  │ … (25 more)");
    expect(lines.at(-1)).toBe("  └");
  });

  it("renders a coalesced failed batch as an aligned per-item summary table", () => {
    const lines = render({
      kind: "tool",
      title: "Fetch 2 URLs",
      status: "error",
      toolGroupItems: [
        { text: "https://one.example", result: "status 403" },
        { text: "https://two.example/nested", result: "status 429" },
      ],
    });
    expect(lines).toEqual([
      "  ⨯ Fetch 2 URLs",
      "  │ https://one.example        status 403",
      "  │ https://two.example/nested status 429",
      "  └",
    ]);
  });

  it("keeps a write's railed content visible after the call settles", () => {
    const lines = render({
      kind: "tool",
      title: "Write ~/app/package.json",
      doneTitle: "Wrote ~/app/package.json",
      status: "done",
      detailLines: [{ text: "{" }, { text: '  "name": "app"' }, { text: "}" }],
      keepDetailWhenDone: true,
    });
    expect(lines).toEqual([
      "  ▪ Wrote ~/app/package.json",
      "  │ {",
      '  │   "name": "app"',
      "  │ }",
      "  └",
    ]);
  });

  it("renders a write diff with marker-aligned added and removed rows", () => {
    const lines = render({
      kind: "tool",
      title: "Write ~/app/package.json",
      doneTitle: "Wrote ~/app/package.json",
      status: "done",
      detailLines: [
        { text: '  "dev": "eve dev",' },
        { text: '  "typecheck": "eve build && tsc"', kind: "added" },
        { text: '  "zod": "^5.6.0"', kind: "removed" },
        { text: "", kind: "gap" },
        { text: "  }" },
      ],
      keepDetailWhenDone: true,
    });
    expect(lines).toEqual([
      "  ▪ Wrote ~/app/package.json",
      '  │    "dev": "eve dev",',
      '  │+   "typecheck": "eve build && tsc"',
      '  │-   "zod": "^5.6.0"',
      "  │ …",
      "  │    }",
      "  └",
    ]);
  });

  it("drops non-write detail once the call settles", () => {
    const lines = render({
      kind: "tool",
      title: "Run pnpm test",
      doneTitle: "Ran pnpm test",
      status: "done",
      detailLines: [{ text: "line one" }, { text: "line two" }],
    });
    expect(lines).toEqual(["  ▪ Ran pnpm test"]);
  });

  it("renders the end-of-turn stats as a standalone dim coda", () => {
    expect(render({ kind: "turn-stats", body: "Done in 3min 24s (↑ 32.4K ↓ 682)" })).toEqual([
      "Done in 3min 24s (↑ 32.4K ↓ 682)",
    ]);
  });

  it("writes a task's start and end as single lines", () => {
    const agent = { kind: "task", taskKind: "agent", title: "researcher", live: false } as const;
    expect(render({ ...agent, subtitle: "Find the Q3 revenue numbers" })).toEqual([
      "  ▪ researcher  Find the Q3 revenue numbers",
    ]);
    expect(
      render({ ...agent, status: "done", body: "finished in 1min 12s · Read 3 files" }),
    ).toEqual(["  ✓ researcher  finished in 1min 12s · Read 3 files"]);
    expect(render({ ...agent, status: "error", body: "failed · Rate limited" })).toEqual([
      "  ⨯ researcher  failed · Rate limited",
    ]);
    expect(render({ ...agent, status: "denied", body: "stopped" })).toEqual([
      "  ▪ researcher  stopped",
    ]);
  });

  it("renders steered and queued messages without extra arrow rows", () => {
    const steered = render({
      kind: "user",
      body: "need to be\n\nsuper accurate",
      promptOrigin: "steer",
    });
    expect(steered).toEqual(["│ need to be", "│ ", "│ super accurate"]);

    const queued = render({ kind: "user", body: "later then", promptOrigin: "queue" });
    expect(queued).toEqual(["│ later then"]);

    // An ordinary typed prompt keeps its bare bar.
    expect(render({ kind: "user", body: "hello" })).toEqual(["│ hello"]);
  });

  it("colors the steered message gutter yellow", () => {
    const colorTheme = createTheme({ color: true, unicode: true });
    const rows = renderBlockLines(
      { kind: "user", body: "go", promptOrigin: "steer" },
      80,
      colorTheme,
      { activityPulse: "▪" },
    );
    expect(rows).toEqual(["\x1b[33m│\x1b[39m \x1b[1mgo\x1b[22m"]);
  });

  it("bolds a sent user message behind an uncolored gutter", () => {
    const colorTheme = createTheme({ color: true, unicode: true });
    const rows = renderBlockLines({ kind: "user", body: "hello" }, 80, colorTheme, {
      activityPulse: "▪",
    });
    expect(rows).toEqual(["│ \x1b[1mhello\x1b[22m"]);
  });

  it("names the agent above the first of its rows, not above each one", () => {
    const row = {
      kind: "subagent-step",
      subagentCallId: "call-1",
      agentName: "researcher",
      depth: 1,
      body: "Checked the filings.",
      live: false,
    } as const;
    expect(render(row)).toEqual(["  ※ researcher", "  │ Checked the filings."]);
    const continued = renderBlockLines(row, 80, theme, {
      activityPulse: "▪",
      previous: { kind: "subagent-tool", subagentCallId: "call-1" },
    }).map(stripAnsi);
    expect(continued).toEqual(["  │ Checked the filings."]);
  });

  it("nests subagent tools under the orange rule", () => {
    const lines = render({
      kind: "subagent-tool",
      depth: 1,
      title: "fetch",
      status: "done",
      result: "ok",
    });
    expect(lines[0]?.startsWith("  │  ▪ fetch")).toBe(true);
  });

  it("never exceeds the available width", () => {
    const long = "lorem ipsum ".repeat(40).trim();
    for (const line of render({ kind: "assistant", body: long }, 40)) {
      expect(visibleLength(line)).toBeLessThanOrEqual(40);
    }
  });

  it("wraps a long question prompt instead of overflowing the row", () => {
    const prompt =
      "Which repository or repositories should the tool check? " +
      "Please provide them in the format owner/repo.";
    const lines = render({ kind: "question", title: prompt, body: "  (type your answer)" }, 40);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines[0]).toBe("? Which repository or repositories");
    expect(lines[1]).toBe("  should the tool check? Please provide");
    for (const line of lines) {
      expect(visibleLength(line)).toBeLessThanOrEqual(40);
    }
  });

  it("hangs a question's answer under the elbow with the shared indent", () => {
    const lines = render({
      kind: "question",
      title: "Choose access",
      body: "⎿  AI Gateway",
    });
    expect(lines).toEqual(["? Choose access", "   ⎿  AI Gateway"]);
  });

  it("renders a dim notice line", () => {
    expect(render({ kind: "notice", body: "Started a new session." })).toEqual([
      "· Started a new session.",
    ]);
  });

  it("renders a multi-line log write as one closed section", () => {
    const lines = render({
      kind: "log",
      title: "stderr",
      body: "turn completed {\n  sessionId: 'x',\n  turnId: 't',\n  sequence: 0\n}",
    });
    expect(lines).toEqual([
      "○ stderr",
      "│ turn completed {",
      "│   sessionId: 'x',",
      "│   turnId: 't',",
      "│   sequence: 0",
      "│ }",
    ]);
  });

  it("renders a coalesced run's elided count under the section header", () => {
    const lines = render({
      kind: "log",
      title: "stderr",
      body: "newest line",
      elided: 52,
    });
    expect(lines).toEqual(["○ stderr", "│ … (52 more)", "│ newest line"]);
  });

  it("renders a one-line log under its source header", () => {
    const lines = render({ kind: "log", title: "stdout", body: "weather lookup { city: 'SF' }" });
    expect(lines).toEqual(["○ stdout", "│ weather lookup { city: 'SF' }"]);
  });

  it("renders sandbox lifecycle lines as first-class progress", () => {
    const lines = render(
      {
        kind: "sandbox",
        body: 'built sandbox template "root" on backend "microsandbox".',
      },
      100,
    );
    expect(lines).toEqual(['│ sandbox · built sandbox template "root" on backend "microsandbox".']);
  });

  it("suppresses the label when sandbox progress continues", () => {
    const indent = " ".repeat("sandbox · ".length);
    const lines = renderBlockLines(
      {
        kind: "sandbox",
        body: 'sandbox template "root" (microsandbox): apt-get update',
      },
      80,
      theme,
      { activityPulse: "▪", previous: { kind: "sandbox" } },
    ).map(stripAnsi);
    expect(lines).toEqual([`│ ${indent}sandbox template "root" (microsandbox): apt-get update`]);
  });

  it("renders a log section identically regardless of what precedes it", () => {
    const lines = renderBlockLines({ kind: "log", title: "stderr", body: "boom" }, 60, theme, {
      activityPulse: "▪",
      previous: { kind: "log", title: "stderr" },
    }).map(stripAnsi);
    expect(lines).toEqual(["○ stderr", "│ boom"]);
  });

  it("renders an error's diagnostic detail beneath the headline", () => {
    const lines = render(
      {
        kind: "error",
        title: "Error",
        body: "TypeError: Cannot read properties of undefined",
        detail:
          "TypeError: Cannot read properties of undefined (reading 'temperature')\n    at getWeather (agent/tools.ts:12:5)",
      },
      100,
    );
    expect(lines[0]).toBe("⨯ Error");
    expect(lines[1]).toBe("  TypeError: Cannot read properties of undefined");
    expect(lines[2]).toBe(
      "  TypeError: Cannot read properties of undefined (reading 'temperature')",
    );
    expect(lines[3]).toBe("      at getWeather (agent/tools.ts:12:5)");
  });

  it("caps long error detail dumps and clips stack frames to one row each", () => {
    const frames = Array.from({ length: 20 }, (_, i) => `    at frame${i} (file.ts:${i}:1)`);
    const lines = render({
      kind: "error",
      title: "Error",
      body: "boom",
      detail: ["Error: boom", ...frames].join("\n"),
    });
    // Headline + body + 12 detail rows + the "+N more" marker.
    expect(lines).toHaveLength(2 + 12 + 1);
    expect(lines.at(-1)).toBe("  … +9 more lines");
    for (const line of lines) {
      expect(visibleLength(line)).toBeLessThanOrEqual(60);
    }
  });
});

describe("error block coloring", () => {
  const colorTheme = createTheme({ color: true, unicode: true });

  it("draws docs URLs in the cyan link color", () => {
    const rows = renderBlockLines(
      {
        kind: "error",
        title: "Error",
        body: "HookConflictError: token in use\n╰› docs: https://workflow-sdk.dev/err/hook-conflict",
      },
      80,
      colorTheme,
      ctx,
    );
    const docsRow = rows.find((row) => row.includes("workflow-sdk.dev"));
    expect(docsRow).toBeDefined();
    // The cyan SGR (36) wraps the URL; the surrounding text stays red (31).
    expect(docsRow).toContain("\x1b[36m");
    expect(docsRow).toContain("\x1b[31m");
  });
});
