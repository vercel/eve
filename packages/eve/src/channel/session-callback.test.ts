import { describe, expect, it } from "vitest";

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
        createCallback("https://agent.example.com/eve/agents/support/eve/v1/callback/tok123"),
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
          "https://agent.example.com/eve/agents/support/eve/v1/callback/eve%3Aparent-token",
          "eve:parent-token",
        ),
      ),
    ).toMatchObject({ ok: true });
  });

  it("rejects a URL without the callback route", () => {
    expect(
      parseSessionCallback(
        createCallback("https://agent.example.com/eve/agents/support/eve/v1/session"),
      ),
    ).toMatchObject({
      message: expect.stringContaining("Callback url token must match callback token"),
      ok: false,
    });
  });

  it("rejects a URL whose token segment does not match the token field", () => {
    expect(
      parseSessionCallback(
        createCallback("https://agent.example.com/eve/agents/support/eve/v1/callback/other-token"),
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
