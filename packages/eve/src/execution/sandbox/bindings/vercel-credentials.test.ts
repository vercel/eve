import { describe, expect, it, vi } from "vitest";

import {
  extractVercelCredentialBrokering,
  resolveVercelCredentialPolicy,
} from "#execution/sandbox/bindings/vercel-credentials.js";

describe("Vercel sandbox credential brokering", () => {
  it("resolves non-interactive credentials for the policy builder", async () => {
    const getToken = vi.fn(async () => ({
      expiresAt: 123,
      token: "secret-token",
    }));
    const buildPolicy = vi.fn(({ service }) => ({
      allow: {
        "api.example.com": [
          {
            transform: [
              {
                headers: {
                  authorization: `Bearer ${service.token}`,
                },
              },
            ],
          },
        ],
      },
    }));
    const { brokering } = extractVercelCredentialBrokering({
      credentials: { service: { getToken } },
      networkPolicy: buildPolicy,
    });

    expect(brokering).toBeDefined();
    await expect(resolveVercelCredentialPolicy(brokering!, "session-key")).resolves.toEqual({
      allow: {
        "api.example.com": [
          {
            transform: [
              {
                headers: {
                  authorization: "Bearer secret-token",
                },
              },
            ],
          },
        ],
      },
    });
    expect(getToken).toHaveBeenCalledWith({
      connection: { url: "" },
      principal: { type: "app" },
    });
    expect(buildPolicy).toHaveBeenNthCalledWith(1, {
      service: { token: "" },
    });
    expect(buildPolicy).toHaveBeenNthCalledWith(2, {
      service: { expiresAt: 123, token: "secret-token" },
    });
  });

  it("uses an empty token when a credential is unavailable", async () => {
    const { brokering } = extractVercelCredentialBrokering({
      credentials: {
        service: {
          getToken: async () => {
            throw new Error("not connected");
          },
        },
      },
      networkPolicy: ({ service }) => ({
        allow: {
          "api.example.com": [
            {
              transform: [
                {
                  headers: {
                    authorization: `Bearer ${service.token}`,
                  },
                },
              ],
            },
          ],
        },
      }),
    });

    await expect(resolveVercelCredentialPolicy(brokering!, "session-key")).resolves.toEqual({
      allow: {
        "api.example.com": [
          {
            transform: [
              {
                headers: {
                  authorization: "Bearer ",
                },
              },
            ],
          },
        ],
      },
    });
  });

  it("rejects incomplete or interactive brokering definitions", () => {
    expect(() =>
      extractVercelCredentialBrokering({
        credentials: { service: { getToken: async () => ({ token: "secret" }) } },
        networkPolicy: "deny-all",
      }),
    ).toThrow(/requires `networkPolicy` to be a function/);

    expect(() =>
      extractVercelCredentialBrokering({
        networkPolicy: () => "deny-all",
      }),
    ).toThrow(/requires at least one entry in `credentials`/);

    expect(() =>
      extractVercelCredentialBrokering({
        credentials: {
          service: {
            completeAuthorization: async () => ({ token: "secret" }),
            getToken: async () => ({ token: "secret" }),
            principalType: "user",
            startAuthorization: async () => ({
              challenge: { url: "https://example.com" },
              resume: {},
            }),
          },
        },
        networkPolicy: () => "deny-all",
      } as never),
    ).toThrow(/interactive authorization is not supported/);
  });
});
