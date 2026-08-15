import { describe, expect, it } from "vitest";

import {
  assertCodexAuthStateAuthenticated,
  parseCodexAuth,
  readCodexJwtExpirationMs,
} from "./auth.js";
import { createUnsignedJwt } from "./unsigned-jwt.js";

const PATHS = { authPath: "/home/user/.codex/auth.json", codexHome: "/home/user/.codex" };

describe("Codex auth state", () => {
  it("parses OAuth login state from auth.json without leaking tokens into the state view", () => {
    const { state, credentials } = parseCodexAuth(
      JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          access_token: "access-token",
          account_id: "acct_123",
          id_token: "id-token",
          refresh_token: "refresh-token",
        },
        last_refresh: "2026-06-29T20:00:00.000Z",
      }),
      PATHS,
    );

    expect(state).toEqual({
      kind: "authenticated",
      accountId: "acct_123",
      authMode: "chatgpt",
      authPath: PATHS.authPath,
      codexHome: PATHS.codexHome,
      lastRefresh: "2026-06-29T20:00:00.000Z",
    });
    expect(JSON.stringify(state)).not.toContain("access-token");
    expect(JSON.stringify(state)).not.toContain("refresh-token");
    expect(credentials).toEqual({
      kind: "chatgpt",
      accessToken: "access-token",
      accountId: "acct_123",
      authPath: PATHS.authPath,
      codexHome: PATHS.codexHome,
      idToken: "id-token",
      lastRefresh: "2026-06-29T20:00:00.000Z",
      refreshToken: "refresh-token",
    });
  });

  it("parses API-key login state and credentials", () => {
    const { state, credentials } = parseCodexAuth(
      JSON.stringify({ auth_mode: "api-key", OPENAI_API_KEY: "sk-test" }),
      PATHS,
    );

    expect(state).toEqual({
      kind: "authenticated",
      authMode: "api-key",
      authPath: PATHS.authPath,
      codexHome: PATHS.codexHome,
    });
    expect(credentials).toEqual({
      kind: "api-key",
      apiKey: "sk-test",
      authPath: PATHS.authPath,
      codexHome: PATHS.codexHome,
    });
  });

  it("falls back to the API key when a chatgpt mode marker has no usable tokens", () => {
    // Stale `auth_mode: "chatgpt"` left behind after tokens were cleared must
    // not outrank a usable API key in the same file.
    const { state, credentials } = parseCodexAuth(
      JSON.stringify({ auth_mode: "chatgpt", tokens: {}, OPENAI_API_KEY: "sk-live" }),
      PATHS,
    );

    expect(state).toMatchObject({ kind: "authenticated", authMode: "api-key" });
    expect(credentials).toMatchObject({ kind: "api-key", apiKey: "sk-live" });
  });

  it("honors an explicit api-key mode over residual OAuth tokens", () => {
    // `codex login --api-key` keeps the old tokens block around; the explicit
    // mode marker decides which credential eve uses.
    const { state, credentials } = parseCodexAuth(
      JSON.stringify({
        auth_mode: "api-key",
        OPENAI_API_KEY: "sk-live",
        tokens: { access_token: "stale-access", refresh_token: "stale-refresh" },
      }),
      PATHS,
    );

    expect(state).toMatchObject({ kind: "authenticated", authMode: "api-key" });
    expect(credentials).toMatchObject({ kind: "api-key", apiKey: "sk-live" });
  });

  it("prefers usable OAuth tokens when no explicit mode is set", () => {
    const { state, credentials } = parseCodexAuth(
      JSON.stringify({
        OPENAI_API_KEY: "sk-live",
        tokens: { access_token: "access-token", refresh_token: "refresh-token" },
      }),
      PATHS,
    );

    expect(state).toMatchObject({ kind: "authenticated", authMode: "chatgpt" });
    expect(credentials).toMatchObject({ kind: "chatgpt", accessToken: "access-token" });
  });

  it("reads JWT expiry without exposing token contents", () => {
    const token = createUnsignedJwt({ exp: 1_783_405_980 });

    expect(readCodexJwtExpirationMs(token)).toBe(1_783_405_980_000);
    expect(readCodexJwtExpirationMs("not.jwt")).toBeUndefined();
  });

  it("treats auth.json with no usable credential as missing login state", () => {
    expect(parseCodexAuth(JSON.stringify({ tokens: {} }), PATHS)).toEqual({
      state: {
        kind: "missing",
        authPath: PATHS.authPath,
        codexHome: PATHS.codexHome,
      },
    });
  });

  it("throws an actionable login error for missing or invalid state", () => {
    expect(() =>
      assertCodexAuthStateAuthenticated({
        kind: "missing",
        authPath: PATHS.authPath,
        codexHome: PATHS.codexHome,
      }),
    ).toThrow("codex login");

    expect(() =>
      assertCodexAuthStateAuthenticated({
        kind: "invalid",
        authPath: PATHS.authPath,
        codexHome: PATHS.codexHome,
        reason: "bad json",
      }),
    ).toThrow("could not be read");
  });
});
