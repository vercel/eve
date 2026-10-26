import { afterEach, describe, expect, it, vi } from "vitest";

import { parseSessionCallback } from "#channel/session-callback.js";

function createCallback(url: string, token = "tok123"): Record<string, unknown> {
  return {
    callId: "call-1",
    subagentName: "research",
    token,
    url,
  };
}

describe("parseSessionCallback callback-URL token extraction", () => {
  it("accepts a callback URL mounted at the origin root", () => {
    expect(
      parseSessionCallback(createCallback("https://agent.example.com/eve/v1/callback/tok123")),
    ).toMatchObject({ ok: true });
  });

  it("accepts a callback URL mounted behind a public route prefix", () => {
    expect(
      parseSessionCallback(
        createCallback("https://agent.example.com/eve/support/v1/callback/tok123"),
      ),
    ).toMatchObject({ ok: true });
  });

  it("reads the token from the last callback route segment", () => {
    expect(
      parseSessionCallback(
        createCallback("https://agent.example.com/eve/v1/callback/x/eve/v1/callback/tok123"),
      ),
    ).toMatchObject({ ok: true });
  });

  it("decodes the encoded token segment before comparing", () => {
    expect(
      parseSessionCallback(
        createCallback(
          "https://agent.example.com/eve/support/v1/callback/eve%3Aparent-token",
          "eve:parent-token",
        ),
      ),
    ).toMatchObject({ ok: true });
  });

  it("rejects a URL without the callback route", () => {
    expect(
      parseSessionCallback(createCallback("https://agent.example.com/eve/support/v1/session")),
    ).toMatchObject({
      message: expect.stringContaining("Callback url token must match callback token"),
      ok: false,
    });
  });

  it("rejects a URL whose token segment does not match the token field", () => {
    expect(
      parseSessionCallback(
        createCallback("https://agent.example.com/eve/support/v1/callback/other-token"),
      ),
    ).toMatchObject({ ok: false });
  });

  it("rejects an empty token segment", () => {
    expect(
      parseSessionCallback(createCallback("https://agent.example.com/eve/v1/callback/")),
    ).toMatchObject({ ok: false });
  });

  it("rejects extra path segments after the token", () => {
    expect(
      parseSessionCallback(createCallback("https://agent.example.com/eve/v1/callback/tok123/more")),
    ).toMatchObject({ ok: false });
  });

  it("rejects a token segment with invalid percent-encoding", () => {
    expect(
      parseSessionCallback(createCallback("https://agent.example.com/eve/v1/callback/%E0%A4%A")),
    ).toMatchObject({ ok: false });
  });
});

describe("parseSessionCallback destination guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
    "http://localhost:3000",
    "http://10.0.0.5",
    "http://169.254.169.254",
    "http://[fd00::1]",
  ])("rejects %s outside local development", (origin) => {
    vi.stubEnv("EVE_DEV", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    expect(parseSessionCallback(createCallback(`${origin}/eve/v1/callback/tok123`))).toMatchObject({
      message: expect.stringContaining("must not be a loopback, private, link-local, or reserved"),
      ok: false,
    });
  });

  it("allows only loopback hosts on a local development server", () => {
    vi.stubEnv("EVE_DEV", "1");

    for (const origin of ["http://127.0.0.1:3000", "http://[::1]:3000", "http://localhost:3000"]) {
      expect(
        parseSessionCallback(createCallback(`${origin}/eve/v1/callback/tok123`)),
        origin,
      ).toMatchObject({ ok: true });
    }
    for (const origin of ["http://10.0.0.5", "http://169.254.169.254"]) {
      expect(
        parseSessionCallback(createCallback(`${origin}/eve/v1/callback/tok123`)),
        origin,
      ).toMatchObject({ ok: false });
    }
  });

  it("rejects non-HTTP schemes", () => {
    expect(
      parseSessionCallback(createCallback("ftp://agent.example.com/eve/v1/callback/tok123")),
    ).toMatchObject({ message: expect.stringContaining("must use http or https"), ok: false });
  });
});
