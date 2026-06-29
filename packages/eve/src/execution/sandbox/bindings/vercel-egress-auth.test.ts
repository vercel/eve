import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import {
  extractVercelEgressAuth,
  resolveVercelEgressPolicy,
} from "#execution/sandbox/bindings/vercel-egress-auth.js";
import { isSandboxAuthorizationInterrupt } from "#execution/sandbox/authorization-interrupt.js";
import { CallbackBaseUrlKey } from "#harness/authorization.js";
import type { VercelSandboxNetworkPolicyRule } from "#public/sandbox/vercel-sandbox.js";

function requiredError(): Error {
  const error = new Error("auth required");
  error.name = "ConnectionAuthorizationRequiredError";
  return error;
}

describe("Vercel sandbox route auth", () => {
  it("resolves authenticated rules and builds native firewall transforms", async () => {
    const getToken = vi.fn(async () => ({ token: "secret" }));
    const { egressAuth } = extractVercelEgressAuth({
      networkPolicy: {
        allow: {
          "api.example.com": [
            {
              auth: { getToken },
              match: { method: ["POST"] },
              transform: ({ token }: { token: string }) => [
                { headers: { authorization: `Bearer ${token}` } },
              ],
            },
          ],
        },
      },
    });

    expect(egressAuth?.clearedPolicy).toEqual({ allow: {}, subnets: undefined });
    await expect(resolveVercelEgressPolicy(egressAuth!, "session")).resolves.toMatchObject({
      allow: {
        "api.example.com": [
          {
            match: { method: ["POST"] },
            transform: [{ headers: { authorization: "Bearer secret" } }],
          },
        ],
      },
    });
    expect(getToken).toHaveBeenCalledOnce();
    expect(getToken).toHaveBeenCalledWith(
      expect.objectContaining({ connection: { url: "https://api.example.com" } }),
    );
  });

  it("preserves native rules while managed credentials are cleared", () => {
    const { egressAuth } = extractVercelEgressAuth({
      networkPolicy: {
        allow: {
          "public.example.com": [],
          "api.example.com": [
            { match: { method: ["GET"] }, transform: [] },
            { auth: { getToken: async () => ({ token: "secret" }) }, transform: () => [] },
          ],
        },
      },
    });

    expect(egressAuth?.clearedPolicy).toEqual({
      allow: {
        "public.example.com": [],
        "api.example.com": [{ match: { method: ["GET"] }, transform: [] }],
      },
      subnets: undefined,
    });
  });

  it("rejects a managed rule moved after discovery", () => {
    const managedRule = {
      auth: { getToken: async () => ({ token: "secret" }) },
      transform: () => [],
    };
    const domainRules: VercelSandboxNetworkPolicyRule[] = [managedRule];
    const { egressAuth } = extractVercelEgressAuth({
      networkPolicy: { allow: { "api.example.com": domainRules } },
    });

    domainRules.unshift({ match: { method: ["GET"] }, transform: [] });

    expect(() => egressAuth?.buildPolicy(new Map())).toThrow(
      'vercel(): managed egress rule at "api.example.com:1" was not discovered.',
    );
  });

  it("leaves a managed route closed when a non-interactive credential is unavailable", async () => {
    const { egressAuth } = extractVercelEgressAuth({
      networkPolicy: {
        allow: {
          "api.example.com": [
            {
              auth: {
                getToken: async () => {
                  throw new Error("provider unavailable");
                },
              },
              transform: () => [],
            },
          ],
        },
      },
    });

    await expect(resolveVercelEgressPolicy(egressAuth!, "sandbox")).resolves.toEqual({
      allow: {},
      subnets: undefined,
    });
  });

  it("parks interactive authorization through the normal callback lifecycle", async () => {
    const startAuthorization = vi.fn(async () => ({
      challenge: { url: "https://provider.example/authorize" },
    }));
    const { egressAuth } = extractVercelEgressAuth({
      networkPolicy: {
        allow: {
          "api.example.com": [
            {
              auth: {
                completeAuthorization: async () => ({ token: "secret" }),
                getToken: async () => {
                  throw requiredError();
                },
                principalType: "user",
                startAuthorization,
              },
              transform: () => [],
            },
          ],
        },
      },
    });
    const context = new ContextContainer();
    context.set(SessionIdKey, "session");
    context.set(CallbackBaseUrlKey, "https://app.example.com");
    context.set(AuthKey, {
      attributes: {},
      authenticator: "test",
      issuer: "test",
      principalId: "user-1",
      principalType: "user",
    });

    const error = await contextStorage.run(
      context,
      async () => await resolveVercelEgressPolicy(egressAuth!, "sandbox").catch((value) => value),
    );

    expect(isSandboxAuthorizationInterrupt(error)).toBe(true);
    expect(startAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackUrl:
          "https://app.example.com/eve/v1/connections/sandbox%3Asandbox%3Ar0-0/callback/session%3Aauth",
      }),
    );
  });

  it("propagates a terminal missing-principal authorization failure", async () => {
    const { egressAuth } = extractVercelEgressAuth({
      networkPolicy: {
        allow: {
          "api.example.com": [
            {
              auth: {
                completeAuthorization: async () => ({ token: "secret" }),
                getToken: async () => {
                  throw requiredError();
                },
                principalType: "user",
                startAuthorization: async () => ({ challenge: {} }),
              },
              transform: () => [],
            },
          ],
        },
      },
    });
    const context = new ContextContainer();
    context.set(SessionIdKey, "session");
    context.set(AuthKey, null);

    await expect(
      contextStorage.run(context, async () => resolveVercelEgressPolicy(egressAuth!, "sandbox")),
    ).rejects.toMatchObject({ reason: "principal_required", retryable: false });
  });
});
