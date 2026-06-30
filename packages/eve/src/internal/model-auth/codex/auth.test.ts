import { describe, expect, it } from "vitest";

import {
  assertCodexAuthStateAuthenticated,
  parseCodexAuthJson,
} from "#internal/model-auth/codex/auth.js";

const PATHS = { authPath: "/home/user/.codex/auth.json", codexHome: "/home/user/.codex" };

describe("Codex auth state", () => {
  it("parses OAuth login state from auth.json without returning token values", () => {
    const state = parseCodexAuthJson(
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
  });

  it("accepts API-key login state as authenticated", () => {
    expect(
      parseCodexAuthJson(
        JSON.stringify({ auth_mode: "api-key", OPENAI_API_KEY: "sk-test" }),
        PATHS,
      ),
    ).toEqual({
      kind: "authenticated",
      authMode: "api-key",
      authPath: PATHS.authPath,
      codexHome: PATHS.codexHome,
    });
  });

  it("treats auth.json with no usable credential as missing login state", () => {
    expect(parseCodexAuthJson(JSON.stringify({ tokens: {} }), PATHS)).toEqual({
      kind: "missing",
      authPath: PATHS.authPath,
      codexHome: PATHS.codexHome,
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
