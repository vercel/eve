import { describe, expect, it } from "vitest";

import { validateWebSocketOrigin } from "#public/channels/index.js";
import type { WebSocketUpgradeRequest } from "#public/channels/index.js";

function upgradeRequest(origin?: string): WebSocketUpgradeRequest {
  const headers = new Headers();

  if (origin !== undefined) {
    headers.set("origin", origin);
  }

  return new Request("https://eve.test/ws", { headers }) as WebSocketUpgradeRequest;
}

describe("validateWebSocketOrigin", () => {
  it("allows an allowlisted origin", () => {
    const result = validateWebSocketOrigin(upgradeRequest("https://app.example.com"), {
      allowedOrigins: ["https://app.example.com"],
    });

    expect(result).toBeUndefined();
  });

  it("normalizes default port, trailing slash, and case when matching", () => {
    const result = validateWebSocketOrigin(upgradeRequest("https://App.Example.com:443"), {
      allowedOrigins: ["https://app.example.com/"],
    });

    expect(result).toBeUndefined();
  });

  it("rejects a non-allowlisted origin with 403", async () => {
    const result = validateWebSocketOrigin(upgradeRequest("https://evil.example"), {
      allowedOrigins: ["https://app.example.com"],
    });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
    await expect((result as Response).json()).resolves.toEqual({
      error: "WebSocket upgrade rejected: Origin is not allowed.",
      ok: false,
    });
  });

  it("rejects a missing Origin header by default", () => {
    const result = validateWebSocketOrigin(upgradeRequest(undefined), {
      allowedOrigins: ["https://app.example.com"],
    });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });

  it("allows a missing Origin header when allowNoOrigin is set", () => {
    const result = validateWebSocketOrigin(upgradeRequest(undefined), {
      allowedOrigins: ["https://app.example.com"],
      allowNoOrigin: true,
    });

    expect(result).toBeUndefined();
  });

  it("rejects the opaque `null` origin even when allowNoOrigin is set", () => {
    const result = validateWebSocketOrigin(upgradeRequest("null"), {
      allowedOrigins: ["https://app.example.com"],
      allowNoOrigin: true,
    });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });

  it("rejects every origin when the allowlist is empty", () => {
    const result = validateWebSocketOrigin(upgradeRequest("https://app.example.com"), {
      allowedOrigins: [],
    });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });
});
