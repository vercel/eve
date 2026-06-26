import { describe, expect, it } from "vitest";

import { buildStatusLine } from "./status-line.js";
import { stripAnsi, visibleLength } from "./terminal-text.js";
import { createTheme } from "./theme.js";
import type { RemoteConnectionSnapshot } from "./remote-connection.js";

const theme = createTheme();
const plain = createTheme({ color: false });
const ascii = createTheme({ color: false, unicode: false });

const identity = { projectName: "my-agent", teamName: "acme" };
const connected = { kind: "gateway", connected: true, credential: "oidc" } as const;
const remoteTarget = {
  kind: "remote",
  serverUrl: "https://vpoke.playground-vercel.tools",
  workspaceRoot: "/tmp/weather-agent",
} as const;

function remote(connection: RemoteConnectionSnapshot["connection"]): RemoteConnectionSnapshot {
  return { target: remoteTarget, connection };
}

function deployedRemote(
  connection: RemoteConnectionSnapshot["connection"],
): RemoteConnectionSnapshot {
  return {
    ...remote(connection),
    deployment: {
      provider: "vercel",
      ownerId: "team_acme",
      projectId: "prj_inbound",
      projectName: "inbound",
      environment: "production",
    },
  };
}

describe("buildStatusLine", () => {
  it("leads local sessions with a gray colon-prefixed port badge", () => {
    const input = {
      serverPort: "3000",
      model: "openai/gpt-5.5",
    } as const;

    const line = buildStatusLine({ ...input, theme, width: 120 })!;
    expect(stripAnsi(line)).toBe(" :3000  openai/gpt-5.5");
    expect(buildStatusLine({ ...input, theme: plain, width: " :3000 ".length })).toBe(" :3000 ");
    expect(line).toContain("\x1b[7m\x1b[90m :3000 \x1b[39m\x1b[27m");
    expect(line).not.toContain("\x1b[7m\x1b[34m :3000 ");
  });

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
      "anthropic/claude-sonnet-4-6 · 12,300 tokens 6% · AI Gateway (my-agent) · /deploy pending",
    );
  });

  it("strips terminal controls from a remote model id", () => {
    expect(
      buildStatusLine({
        model: "openai/gpt\x1b[31m-5\n",
        remote: remote({ state: "ready", info: {} as never }),
        theme: plain,
        width: 120,
      }),
    ).toBe(" ↗ vpoke.playground-vercel.tools  openai/gpt-5");
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
    expect(withProject).toBe("m · AI Gateway (my-agent)");

    // Connected without a linked project (a raw key): bare "AI Gateway".
    const noProject = buildStatusLine({
      model: "m",
      endpoint: connected,
      theme: plain,
      width: 120,
    });
    expect(noProject).toBe("m · AI Gateway");
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
    expect(full.startsWith("logs: sandbox · ")).toBe(true);

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
    expect(noModel).toBe("12,300 tokens · /deploy pending");
  });

  it("renders the three model-endpoint states", () => {
    const external = buildStatusLine({
      model: "anthropic/claude-sonnet-4-6",
      endpoint: { kind: "external", provider: "anthropic" },
      theme: plain,
      width: 120,
    });
    expect(external).toBe("anthropic/claude-sonnet-4-6 · External endpoint");

    const linked = buildStatusLine({
      model: "m",
      endpoint: connected,
      vercel: { identity, pendingDeploy: false },
      theme: plain,
      width: 120,
    });
    expect(linked).toBe("m · AI Gateway (my-agent)");

    const notConnected = buildStatusLine({
      model: "m",
      endpoint: { kind: "gateway", connected: false },
      theme: plain,
      width: 120,
    });
    expect(notConnected).toBe("m · ⚠ AI Gateway");
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
    expect(stripAnsi(line!)).toBe("m - ! AI Gateway");
  });

  it("renders the remote badge first and projects each authentication state", () => {
    expect(
      buildStatusLine({
        remote: remote({ state: "checking" }),
        theme: plain,
        width: 120,
      }),
    ).toBe(" ↗ vpoke.playground-vercel.tools · Checking access…");
    expect(
      buildStatusLine({
        remote: remote({
          state: "auth-required",
          challenge: { kind: "eve-oidc" },
        }),
        theme: plain,
        width: 120,
      }),
    ).toBe(" ↗ vpoke.playground-vercel.tools · Authenticate via OIDC");
    expect(
      buildStatusLine({
        remote: remote({
          state: "authenticating",
          challenge: { kind: "eve-oidc" },
        }),
        theme: plain,
        width: 120,
      }),
    ).toBe(" ↗ vpoke.playground-vercel.tools · Authenticating via OIDC…");
    expect(
      buildStatusLine({
        remote: remote({
          state: "auth-failed",
          challenge: { kind: "eve-oidc" },
        }),
        theme: plain,
        width: 120,
      }),
    ).toBe(" ↗ vpoke.playground-vercel.tools · Authentication failed");
    expect(
      buildStatusLine({
        remote: remote({
          state: "unavailable",
          failure: { message: "offline" },
        }),
        theme: plain,
        width: 120,
      }),
    ).toBe(" ↗ vpoke.playground-vercel.tools · Remote unavailable");
    expect(
      buildStatusLine({
        remote: deployedRemote({ state: "ready", info: {} as never }),
        theme: plain,
        width: 120,
      }),
    ).toBe(" ↗ inbound (production) ");
  });

  it("paints the remote badge from its connection state", () => {
    const disconnected = buildStatusLine({
      remote: remote({
        state: "unavailable",
        failure: { message: "offline" },
      }),
      theme,
      width: 120,
    })!;
    const notConnected = buildStatusLine({
      remote: remote({
        state: "auth-required",
        challenge: { kind: "eve-oidc" },
      }),
      theme,
      width: 120,
    })!;
    const connectedLine = buildStatusLine({
      remote: deployedRemote({ state: "ready", info: {} as never }),
      theme,
      width: 120,
    })!;

    expect(disconnected).toContain(
      "\x1b[7m\x1b[33m ↗ vpoke.playground-vercel.tools \x1b[39m\x1b[27m",
    );
    expect(notConnected).toContain(
      "\x1b[7m\x1b[33m ↗ vpoke.playground-vercel.tools \x1b[39m\x1b[27m",
    );
    expect(notConnected).not.toContain("\x1b[43m");
    expect(notConnected).not.toContain("/vc:login");
    expect(disconnected).not.toContain("/vc:login");
    expect(connectedLine).toContain("\x1b[7m\x1b[34m ↗ inbound (production) \x1b[39m\x1b[27m");
    const badges = `${disconnected}${notConnected}${connectedLine}`;
    expect(badges).not.toContain("\x1b[44m");
    expect(badges).not.toContain("\x1b[100m");
  });

  it("omits endpoint status for a remote and preserves the badge as width narrows", () => {
    const line = buildStatusLine({
      remote: deployedRemote({ state: "ready", info: {} as never }),
      model: "openai/gpt-5.5",
      tokens: "↑ 200 ↓ 100",
      endpoint: { kind: "gateway", connected: false },
      theme,
      width: 120,
    })!;

    expect(stripAnsi(line)).not.toContain("AI Gateway");
    expect(
      stripAnsi(
        buildStatusLine({
          remote: deployedRemote({ state: "ready", info: {} as never }),
          model: "openai/gpt-5.5",
          tokens: "↑ 200 ↓ 100",
          theme: plain,
          width: 24,
        })!,
      ),
    ).toBe(" ↗ inbound (production) ");
  });

  it("closes the remote badge style when the narrowest variant is clipped", () => {
    const line = buildStatusLine({
      remote: deployedRemote({ state: "ready", info: {} as never }),
      theme,
      width: 8,
    });

    expect(line).toBeDefined();
    expect(line?.endsWith("\x1b[0m")).toBe(true);
    expect(stripAnsi(line ?? "")).toBe(" ↗ inbou");
  });

  it("uses the ASCII separator when unicode is unavailable", () => {
    const line = buildStatusLine({
      remote: remote({ state: "checking" }),
      theme: ascii,
      width: 120,
    });
    expect(line).toBe(" -> vpoke.playground-vercel.tools - Checking access…");
  });
});
