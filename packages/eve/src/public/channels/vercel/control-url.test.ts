import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveControlUrl } from "#public/channels/vercel/control-url.js";

const wsPath = "/eve/v1/realtime-speech/ws";

function clearControlEnv() {
  delete process.env.EVE_REALTIME_CONTROL_URL;
  delete process.env.VERCEL_BRANCH_URL;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  delete process.env.VERCEL_DPBP;
}

// The dev shell may export VERCEL_DPBP; clear it so "no bypass" cases are
// deterministic regardless of ambient env.
beforeEach(clearControlEnv);
afterEach(clearControlEnv);

describe("resolveControlUrl", () => {
  it("honors an explicit override URL", () => {
    const url = resolveControlUrl({
      wsPath,
      explicitUrl: "wss://tunnel.ngrok.app/eve/v1/realtime-speech/ws",
    });
    expect(url).toBe("wss://tunnel.ngrok.app/eve/v1/realtime-speech/ws");
  });

  it("derives a wss URL from the Vercel deployment host", () => {
    process.env.VERCEL_BRANCH_URL = "eve-preview.vercel.app";
    const url = resolveControlUrl({ wsPath });
    expect(url).toBe("wss://eve-preview.vercel.app/eve/v1/realtime-speech/ws");
  });

  it("appends the deploy-protection bypass secret as a query param", () => {
    process.env.VERCEL_URL = "eve-preview.vercel.app";
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "bypass123";
    const url = new URL(resolveControlUrl({ wsPath }));
    expect(url.searchParams.get("x-vercel-protection-bypass")).toBe("bypass123");
  });

  it("does not append deploy-protection bypass secrets to non-Vercel hosts", () => {
    process.env.VERCEL_DPBP = "ambient-bypass";
    const url = new URL(
      resolveControlUrl({
        wsPath,
        explicitUrl: "wss://tunnel.ngrok.app/eve/v1/realtime-speech/ws",
      }),
    );
    expect(url.searchParams.get("x-vercel-protection-bypass")).toBe(null);
  });

  it("uses an explicit bypass secret for Vercel hosts", () => {
    const url = new URL(
      resolveControlUrl({
        wsPath,
        explicitUrl: "wss://eve-preview.vercel.app/eve/v1/realtime-speech/ws",
        bypassSecret: "explicit-bypass",
      }),
    );
    expect(url.searchParams.get("x-vercel-protection-bypass")).toBe("explicit-bypass");
  });

  it("throws when no control URL or deployment host is configured", () => {
    expect(() => resolveControlUrl({ wsPath })).toThrow(/EVE_REALTIME_CONTROL_URL/);
  });

  it("rejects public ws:// control URLs", () => {
    expect(() =>
      resolveControlUrl({
        wsPath,
        explicitUrl: "ws://app.example.com/eve/v1/realtime-speech/ws",
      }),
    ).toThrow(/wss:\/\//);
  });

  it("uses ws:// for localhost overrides", () => {
    const url = resolveControlUrl({
      wsPath,
      explicitUrl: "ws://localhost:3000/eve/v1/realtime-speech/ws",
    });
    expect(url).toBe("ws://localhost:3000/eve/v1/realtime-speech/ws");
  });
});
