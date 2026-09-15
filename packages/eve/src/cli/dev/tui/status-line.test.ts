import { describe, expect, it } from "vitest";

import { buildStatusLine } from "./status-line.js";
import { stripAnsi, visibleLength } from "#cli/ui/terminal-text.js";
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
  it("shows a Vercel team slug without a local port or routing prose", () => {
    const line = buildStatusLine({
      model: "openai/gpt-5.6-luna-fast",
      endpoint: { kind: "gateway", connected: true, credential: "oauth", team: "team_internal" },
      vercel: { modelTeamSlug: "acme" },
      theme: plain,
      width: 120,
    });
    expect(line).toBe("openai/gpt-5.6-luna-fast · Vercel · acme");
  });

  it("omits raw team IDs while the slug is unavailable", () => {
    expect(
      buildStatusLine({
        model: "m",
        endpoint: { kind: "gateway", connected: true, credential: "oauth", team: "team_internal" },
        theme: plain,
        width: 120,
      }),
    ).toBe("m · Vercel");
  });

  it("renders all segments in order with dot separators", () => {
    const line = buildStatusLine({
      model: "anthropic/claude-sonnet-5",
      endpoint: connected,
      vercel: { identity },
      theme: plain,
      width: 120,
    });

    expect(line).toBe("anthropic/claude-sonnet-5 · ai-gateway(oidc:my-agent)");
  });

  it("folds the reasoning level and Fast mode marker into the model segment", () => {
    const line = buildStatusLine({
      model: "xai/grok-4.5",
      reasoning: "xhigh",
      fastMode: true,
      endpoint: connected,
      vercel: { identity },
      theme: plain,
      width: 120,
    });

    expect(line).toBe("xai/grok-4.5@xhigh ↯ · ai-gateway(oidc:my-agent)");
  });

  it("dims the whole model segment, reasoning level and fast marker included", () => {
    const line = buildStatusLine({
      model: "xai/grok-4.5",
      reasoning: "xhigh",
      fastMode: true,
      theme,
      width: 120,
    })!;

    expect(line).toContain("\x1b[2mxai/grok-4.5@xhigh ↯\x1b[22m");
  });

  it("renders the fast marker with ASCII glyphs when unicode is unavailable", () => {
    const line = buildStatusLine({
      model: "xai/grok-4.5",
      fastMode: true,
      theme: ascii,
      width: 120,
    });

    expect(line).toBe("xai/grok-4.5 >>");
  });

  it("strips terminal controls from a remote model id", () => {
    expect(
      buildStatusLine({
        model: "openai/gpt\x1b[31m-5\n",
        reasoning: "high",
        fastMode: true,
        remote: remote({ state: "ready", info: {} as never }),
        theme: plain,
        width: 120,
      }),
    ).toBe(" ↗ vpoke.playground-vercel.tools  openai/gpt-5@high ↯");
  });

  it("dims the model segment", () => {
    const line = buildStatusLine({
      model: "anthropic/claude-sonnet-5",
      endpoint: connected,
      vercel: { identity },
      theme,
      width: 120,
    });

    expect(line).toContain("\x1b[2manthropic/claude-sonnet-5\x1b[22m");
  });

  it("folds the linked project name into the connected gateway label", () => {
    const withProject = buildStatusLine({
      model: "m",
      endpoint: connected,
      vercel: { identity },
      theme: plain,
      width: 120,
    });
    expect(withProject).toBe("m · ai-gateway(oidc:my-agent)");

    // OIDC without a resolved project name: bare scope.
    const noProject = buildStatusLine({
      model: "m",
      endpoint: connected,
      theme: plain,
      width: 120,
    });
    expect(noProject).toBe("m · ai-gateway(oidc)");
  });

  it("right-aligns monochrome build status and preserves it at narrow widths", () => {
    const status = (phase: "building" | "complete", width = 120) =>
      buildStatusLine({
        devBuild: { phase, summary: "agent/instructions.md changed" },
        model: "anthropic/claude-sonnet-5",
        theme,
        width,
      })!;

    const building = status("building");
    const complete = status("complete");
    expect(stripAnsi(building)).toMatch(
      /^anthropic\/claude-sonnet-5 +▪ agent\/instructions\.md updating…$/u,
    );
    expect(stripAnsi(complete)).toMatch(
      /^anthropic\/claude-sonnet-5 +✓ agent\/instructions\.md updated$/u,
    );
    expect(visibleLength(complete)).toBe(120);
    expect(complete).not.toContain("\x1b[32m");
    expect(stripAnsi(status("complete", 20))).toBe("✓ agent/instructions");
  });

  it("leads with the transient logs hint and keeps it as width narrows", () => {
    const input = {
      logLevel: "sandbox",
      model: "anthropic/claude-sonnet-5",
      endpoint: connected,
      vercel: { identity },
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
    expect(buildStatusLine({ vercel: {}, theme: plain, width: 120 })).toBeUndefined();
  });

  it("drops the endpoint, then the model, as the width narrows", () => {
    const input = {
      model: "anthropic/claude-sonnet-5",
      endpoint: connected,
      vercel: { identity },
      theme: plain,
    };
    const full = buildStatusLine({ ...input, width: 200 })!;
    expect(full).toContain("ai-gateway(oidc:my-agent)");

    const noEndpoint = buildStatusLine({ ...input, width: visibleLength(full) - 1 })!;
    expect(noEndpoint).not.toContain("ai-gateway");
    expect(noEndpoint).toContain("anthropic/claude-sonnet-5");

    const noModel = buildStatusLine({ ...input, width: visibleLength(noEndpoint) - 1 })!;
    expect(noModel).not.toContain("ai-gateway");
  });

  it("renders the three model-endpoint states", () => {
    const external = buildStatusLine({
      model: "anthropic/claude-sonnet-5",
      endpoint: { kind: "external", provider: "anthropic" },
      theme: plain,
      width: 120,
    });
    expect(external).toBe("anthropic/claude-sonnet-5 · anthropic⌝");

    const linked = buildStatusLine({
      model: "m",
      endpoint: connected,
      vercel: { identity },
      theme: plain,
      width: 120,
    });
    expect(linked).toBe("m · ai-gateway(oidc:my-agent)");

    const apiKey = buildStatusLine({
      model: "m",
      endpoint: { kind: "gateway", connected: true, credential: "api-key" },
      // A linked project must NOT surface here: the key is what
      // authenticates, and the bar reports the credential in use.
      vercel: { identity },
      theme: plain,
      width: 120,
    });
    expect(apiKey).toBe("m · ai-gateway(api-key)");

    const chatgpt = buildStatusLine({
      model: "openai/gpt-5.6-sol",
      endpoint: { kind: "chatgpt", state: "ready" },
      theme: plain,
      width: 120,
    });
    expect(chatgpt).toBe("openai/gpt-5.6-sol · chatgpt-sub⌝");

    const chatgptLogin = buildStatusLine({
      model: "openai/gpt-5.6-sol",
      endpoint: { kind: "chatgpt", state: "reauth-required" },
      theme: plain,
      width: 120,
    });
    expect(chatgptLogin).toBe("openai/gpt-5.6-sol · ⚠ chatgpt-sub login · /login");

    const notConnected = buildStatusLine({
      model: "m",
      endpoint: { kind: "gateway", connected: false },
      theme: plain,
      width: 120,
    });
    expect(notConnected).toBe("m · ⚠ ai-gateway");
  });

  it("paints only the not-connected endpoint yellow", () => {
    const notConnected = buildStatusLine({
      endpoint: { kind: "gateway", connected: false },
      theme,
      width: 120,
    });
    expect(notConnected).toContain("\x1b[33m⚠ ai-gateway\x1b[39m");

    const linked = buildStatusLine({
      endpoint: connected,
      theme,
      width: 120,
    });
    // Only the gateway stands at the terminal's default foreground — no
    // explicit white, no bold; the scope stays dim.
    expect(linked).toContain("ai-gateway\x1b[2m(oidc)\x1b[22m");
    expect(linked).not.toContain("\x1b[97m");
    expect(linked).not.toContain("\x1b[1mai-gateway");

    // External providers render quiet — no bright token — with only the
    // authored-endpoint mark at the default foreground.
    const external = buildStatusLine({
      endpoint: { kind: "external", provider: "codex" },
      theme,
      width: 120,
    });
    expect(external).toContain("\x1b[2mchatgpt-sub\x1b[22m⌝");
    expect(external).not.toContain("\x1b[1m");
  });

  it("renders ASCII glyphs when unicode is unavailable", () => {
    const gateway = buildStatusLine({
      model: "m",
      endpoint: { kind: "gateway", connected: false },
      theme: ascii,
      width: 120,
    });
    expect(stripAnsi(gateway!)).toBe("m · ! ai-gateway");

    const chatgpt = buildStatusLine({
      model: "openai/gpt-5.6-sol",
      endpoint: { kind: "chatgpt", state: "ready" },
      theme: ascii,
      width: 120,
    });
    expect(stripAnsi(chatgpt!)).toBe("openai/gpt-5.6-sol · chatgpt-sub^");
  });

  it("renders the remote badge first and projects each authentication state", () => {
    expect(
      buildStatusLine({
        remote: remote({ state: "checking" }),
        theme: plain,
        width: 120,
      }),
    ).toBe(" ↗ vpoke.playground-vercel.tools  Checking access…");
    expect(
      buildStatusLine({
        remote: remote({
          state: "auth-required",
          challenge: { kind: "eve-oidc" },
        }),
        theme: plain,
        width: 120,
      }),
    ).toBe(" ↗ vpoke.playground-vercel.tools  Authenticate via OIDC");
    expect(
      buildStatusLine({
        remote: remote({
          state: "authenticating",
          challenge: { kind: "eve-oidc" },
        }),
        theme: plain,
        width: 120,
      }),
    ).toBe(" ↗ vpoke.playground-vercel.tools  Authenticating via OIDC…");
    expect(
      buildStatusLine({
        remote: remote({
          state: "auth-failed",
          challenge: { kind: "eve-oidc" },
        }),
        theme: plain,
        width: 120,
      }),
    ).toBe(" ↗ vpoke.playground-vercel.tools  Authentication failed");
    expect(
      buildStatusLine({
        remote: remote({
          state: "unavailable",
          failure: { message: "offline" },
        }),
        theme: plain,
        width: 120,
      }),
    ).toBe(" ↗ vpoke.playground-vercel.tools  Remote unavailable");
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
    expect(notConnected).not.toContain("/deploy");
    expect(disconnected).not.toContain("/deploy");
    expect(connectedLine).toContain("\x1b[7m\x1b[34m ↗ inbound (production) \x1b[39m\x1b[27m");
    const badges = `${disconnected}${notConnected}${connectedLine}`;
    expect(badges).not.toContain("\x1b[44m");
    expect(badges).not.toContain("\x1b[100m");
  });

  it("omits endpoint status for a remote and preserves the badge as width narrows", () => {
    const line = buildStatusLine({
      remote: deployedRemote({ state: "ready", info: {} as never }),
      model: "openai/gpt-5.5",
      endpoint: { kind: "gateway", connected: false },
      theme,
      width: 120,
    })!;

    expect(stripAnsi(line)).not.toContain("ai-gateway");
    expect(
      stripAnsi(
        buildStatusLine({
          remote: deployedRemote({ state: "ready", info: {} as never }),
          model: "openai/gpt-5.5",
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

  it("keeps dot separators when unicode is unavailable", () => {
    const line = buildStatusLine({
      remote: remote({ state: "checking" }),
      theme: ascii,
      width: 120,
    });
    expect(line).toBe(" -> vpoke.playground-vercel.tools  Checking access…");
  });
});
