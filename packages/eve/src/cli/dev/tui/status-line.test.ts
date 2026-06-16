import { describe, expect, it } from "vitest";

import { buildStatusLine } from "./status-line.js";
import { stripAnsi, visibleLength } from "./terminal-text.js";
import { createTheme } from "./theme.js";

const theme = createTheme();
const plain = createTheme({ color: false });
const ascii = createTheme({ color: false, unicode: false });

const identity = { projectName: "my-agent", teamName: "acme" };
const connected = { kind: "gateway", connected: true, credential: "oidc" } as const;

describe("buildStatusLine", () => {
  it("renders all segments in order with dot separators", () => {
    const line = buildStatusLine({
      model: "anthropic/claude-sonnet-4-6",
      tokens: "12,300 tokens 6%",
      endpoint: connected,
      vercel: { identity, pendingDeploy: true },
      theme: plain,
      width: 120,
    });

    expect(line).toBe(
      "anthropic/claude-sonnet-4-6  ·  12,300 tokens 6%  ·  AI Gateway (my-agent)  ·  /deploy pending",
    );
  });

  it("dims every segment except the yellow pending-deploy marker", () => {
    const line = buildStatusLine({
      model: "anthropic/claude-sonnet-4-6",
      endpoint: connected,
      vercel: { identity, pendingDeploy: true },
      theme,
      width: 120,
    });

    expect(line).toContain("\x1b[2manthropic/claude-sonnet-4-6\x1b[22m");
    expect(line).toContain("\x1b[33m/deploy pending\x1b[39m");
    expect(line).not.toContain("\x1b[2m/deploy pending");
  });

  it("folds the linked project name into the connected gateway label", () => {
    const withProject = buildStatusLine({
      model: "m",
      endpoint: connected,
      vercel: { identity, pendingDeploy: false },
      theme: plain,
      width: 120,
    });
    expect(withProject).toBe("m  ·  AI Gateway (my-agent)");

    // Connected without a linked project (a raw key): bare "AI Gateway".
    const noProject = buildStatusLine({
      model: "m",
      endpoint: connected,
      theme: plain,
      width: 120,
    });
    expect(noProject).toBe("m  ·  AI Gateway");
  });

  it("renders the pending marker even when no segment else resolved", () => {
    const line = buildStatusLine({
      vercel: { pendingDeploy: true },
      theme: plain,
      width: 120,
    });
    expect(line).toBe("/deploy pending");
  });

  it("leads with the transient logs hint and keeps it as width narrows", () => {
    const input = {
      logLevel: "sandbox",
      model: "anthropic/claude-sonnet-4-6",
      tokens: "↑ 500 ↓ 300",
      endpoint: connected,
      vercel: { identity, pendingDeploy: true },
      theme: plain,
    } as const;

    const full = buildStatusLine({ ...input, width: 120 })!;
    expect(full.startsWith("logs: sandbox  ·  ")).toBe(true);

    // Narrow enough that only the leading hint survives.
    expect(buildStatusLine({ ...input, width: 13 })).toBe("logs: sandbox");
  });

  it("renders the logs hint alone at a bare prompt", () => {
    expect(buildStatusLine({ logLevel: "none", theme: plain, width: 120 })).toBe("logs: none");
  });

  it("returns undefined when every segment is empty", () => {
    expect(buildStatusLine({ theme: plain, width: 120 })).toBeUndefined();
    expect(
      buildStatusLine({ vercel: { pendingDeploy: false }, theme: plain, width: 120 }),
    ).toBeUndefined();
  });

  it("drops the endpoint, then the model, as the width narrows", () => {
    const input = {
      model: "anthropic/claude-sonnet-4-6",
      tokens: "12,300 tokens",
      endpoint: connected,
      vercel: { identity, pendingDeploy: true },
      theme: plain,
    };
    const full = buildStatusLine({ ...input, width: 200 })!;
    expect(full).toContain("AI Gateway (my-agent)");

    const noEndpoint = buildStatusLine({ ...input, width: visibleLength(full) - 1 })!;
    expect(noEndpoint).not.toContain("AI Gateway");
    expect(noEndpoint).toContain("anthropic/claude-sonnet-4-6");

    const noModel = buildStatusLine({ ...input, width: visibleLength(noEndpoint) - 1 })!;
    expect(noModel).toBe("12,300 tokens  ·  /deploy pending");
  });

  it("renders the three model-endpoint states", () => {
    const external = buildStatusLine({
      model: "anthropic/claude-sonnet-4-6",
      endpoint: { kind: "external", provider: "anthropic" },
      theme: plain,
      width: 120,
    });
    expect(external).toBe("anthropic/claude-sonnet-4-6  ·  External endpoint");

    const linked = buildStatusLine({
      model: "m",
      endpoint: connected,
      vercel: { identity, pendingDeploy: false },
      theme: plain,
      width: 120,
    });
    expect(linked).toBe("m  ·  AI Gateway (my-agent)");

    const notConnected = buildStatusLine({
      model: "m",
      endpoint: { kind: "gateway", connected: false },
      theme: plain,
      width: 120,
    });
    expect(notConnected).toBe("m  ·  ⚠ AI Gateway");
  });

  it("paints only the not-connected endpoint yellow", () => {
    const notConnected = buildStatusLine({
      endpoint: { kind: "gateway", connected: false },
      theme,
      width: 120,
    });
    expect(notConnected).toContain("\x1b[33m⚠ AI Gateway\x1b[39m");

    const linked = buildStatusLine({
      endpoint: connected,
      theme,
      width: 120,
    });
    expect(linked).toContain("\x1b[2mAI Gateway\x1b[22m");
  });

  it("renders ASCII glyphs when unicode is unavailable", () => {
    const line = buildStatusLine({
      model: "m",
      endpoint: { kind: "gateway", connected: false },
      theme: ascii,
      width: 120,
    });
    expect(stripAnsi(line!)).toBe("m  -  ! AI Gateway");
  });
});
