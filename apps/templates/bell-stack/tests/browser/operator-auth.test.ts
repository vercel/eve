import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { operatorAuth } from "../../server/operator-auth";

const password = "synthetic-operator-password-at-least-32-bytes";
const origin = "https://bell.example";
const authorization = `Basic ${Buffer.from(`operator:${password}`).toString("base64")}`;

function request(path: string, init: RequestInit = {}) {
  return new Request(`${origin}${path}`, {
    ...init,
    headers: { authorization, origin, ...init.headers },
  });
}

beforeEach(() => {
  vi.stubEnv("BELL_OPERATOR_USERNAME", "operator");
  vi.stubEnv("BELL_OPERATOR_PASSWORD", password);
});

afterEach(() => vi.unstubAllEnvs());

describe("operator authentication", () => {
  it.each(["", "short"])("fails closed with an absent or weak operator password", value => {
    vi.stubEnv("BELL_OPERATOR_PASSWORD", value);
    expect(operatorAuth(request("/"))).toBeNull();
  });

  it("rejects unauthenticated users and accepts the configured operator", () => {
    expect(operatorAuth(new Request(origin))).toBeNull();
    expect(operatorAuth(request("/"))).not.toBeNull();
  });

  it("rejects cross-origin writes even with an authenticated operator", () => {
    expect(() => operatorAuth(request("/eve/v1/sessions/example/cancel", {
      method: "POST",
      headers: { origin: "https://other.example", "sec-fetch-site": "same-origin" },
    }))).toThrow();
  });

  it("lets server bearer requests reach the next authentication strategy", () => {
    expect(operatorAuth(new Request(`${origin}/eve/v1/session`, {
      method: "POST", headers: { authorization: "Bearer synthetic-token" }, body: "{}",
    }))).toBeNull();
  });
});
