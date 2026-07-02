import { describe, expect, it } from "vitest";

import { resolveModelEndpointStatus } from "#internal/resolve-model-endpoint-status.js";
import { createUnsignedJwt } from "#internal/testing/unsigned-jwt.js";

const CODEX_AUTH_PATH = "/home/user/.codex/auth.json";
const CODEX_HOME = "/home/user/.codex";

describe("resolveModelEndpointStatus", () => {
  it("reports an external model configuration without a connectedness claim", async () => {
    await expect(
      resolveModelEndpointStatus({ routing: { kind: "external", provider: "anthropic" } }),
    ).resolves.toEqual({ kind: "external", provider: "anthropic" });
  });

  it("reports gateway connected via api-key, which outranks oidc", async () => {
    await expect(
      resolveModelEndpointStatus(
        { routing: { kind: "gateway", target: "openai" } },
        {
          env: { AI_GATEWAY_API_KEY: "gateway-key" },
          getOidcToken: async () => "oidc-token",
        },
      ),
    ).resolves.toEqual({ kind: "gateway", connected: true, credential: "api-key" });
  });

  it("reports gateway connected via oidc when only the token is present", async () => {
    await expect(
      resolveModelEndpointStatus(
        { routing: { kind: "gateway", target: "openai" } },
        {
          env: {},
          getOidcToken: async () => "oidc-token",
        },
      ),
    ).resolves.toEqual({ kind: "gateway", connected: true, credential: "oidc" });
  });

  it("reports gateway disconnected when neither credential is present", async () => {
    await expect(
      resolveModelEndpointStatus(
        { routing: { kind: "gateway", target: "openai" } },
        {
          env: {},
          getOidcToken: async () => {
            throw new Error("not linked");
          },
        },
      ),
    ).resolves.toEqual({ kind: "gateway", connected: false });
  });

  it("reports Codex connected from API-key login state", async () => {
    await expect(
      resolveModelEndpointStatus(
        { routing: { kind: "gateway", target: "openai" }, transport: "codex" },
        {
          readCodexAuth: async () => ({
            state: {
              kind: "authenticated",
              authMode: "api-key",
              authPath: CODEX_AUTH_PATH,
              codexHome: CODEX_HOME,
            },
            credentials: {
              kind: "api-key",
              apiKey: "sk-test",
              authPath: CODEX_AUTH_PATH,
              codexHome: CODEX_HOME,
            },
          }),
        },
      ),
    ).resolves.toEqual({ kind: "codex", connected: true, credential: "api-key" });
  });

  it("reports Codex connected when ChatGPT auth can refresh", async () => {
    await expect(
      resolveModelEndpointStatus(
        { routing: { kind: "gateway", target: "openai" }, transport: "codex" },
        {
          now: () => 1_000,
          readCodexAuth: async () => ({
            state: {
              kind: "authenticated",
              authMode: "chatgpt",
              authPath: CODEX_AUTH_PATH,
              codexHome: CODEX_HOME,
            },
            credentials: {
              kind: "chatgpt",
              authPath: CODEX_AUTH_PATH,
              codexHome: CODEX_HOME,
              refreshToken: "refresh-token",
            },
          }),
        },
      ),
    ).resolves.toEqual({ kind: "codex", connected: true, credential: "chatgpt" });
  });

  it("reports Codex disconnected when ChatGPT auth cannot refresh", async () => {
    await expect(
      resolveModelEndpointStatus(
        { routing: { kind: "gateway", target: "openai" }, transport: "codex" },
        {
          now: () => 1_000,
          readCodexAuth: async () => ({
            state: {
              kind: "authenticated",
              authMode: "chatgpt",
              authPath: CODEX_AUTH_PATH,
              codexHome: CODEX_HOME,
            },
            credentials: {
              kind: "chatgpt",
              accessToken: createUnsignedJwt({ exp: 1 }),
              authPath: CODEX_AUTH_PATH,
              codexHome: CODEX_HOME,
            },
          }),
        },
      ),
    ).resolves.toEqual({ kind: "codex", connected: false, reason: "refresh-token-missing" });
  });

  it("reports missing and invalid Codex login state", async () => {
    await expect(
      resolveModelEndpointStatus(
        { routing: { kind: "gateway", target: "openai" }, transport: "codex" },
        {
          readCodexAuth: async () => ({
            state: { kind: "missing", authPath: CODEX_AUTH_PATH, codexHome: CODEX_HOME },
          }),
        },
      ),
    ).resolves.toEqual({ kind: "codex", connected: false, reason: "missing" });

    await expect(
      resolveModelEndpointStatus(
        { routing: { kind: "gateway", target: "openai" }, transport: "codex" },
        {
          readCodexAuth: async () => ({
            state: {
              kind: "invalid",
              authPath: CODEX_AUTH_PATH,
              codexHome: CODEX_HOME,
              reason: "bad json",
            },
          }),
        },
      ),
    ).resolves.toEqual({ kind: "codex", connected: false, reason: "invalid" });
  });
});
