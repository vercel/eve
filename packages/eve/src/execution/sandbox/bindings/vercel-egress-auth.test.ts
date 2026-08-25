import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import {
  activateVercelEgressRules,
  extractVercelEgressAuth,
  resolveVercelEgressPolicy,
  type VercelEgressAuth,
} from "#execution/sandbox/bindings/vercel-egress-auth.js";
import { vercelEgressRuleId } from "#execution/sandbox/bindings/vercel-egress-demand.js";
import { isAuthorizationInterrupt } from "#harness/authorization-interrupt.js";
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
    const resolved = await resolveVercelEgressPolicy({
      egressAuth: egressAuth!,
      sessionKey: "session",
    });
    expect(egressAuth!.buildPolicy(resolved.credentials)).toMatchObject({
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

    const resolved = await resolveVercelEgressPolicy({
      egressAuth: egressAuth!,
      sessionKey: "sandbox",
    });
    // Rule ids derive from the domain (sha256 prefix) plus the rule index,
    // so reordering the authored policy cannot re-attribute grants.
    expect(resolved.unresolvedRuleIds).toEqual(["r-d0c43d388506-0"]);
    expect(egressAuth!.buildPolicy(resolved.credentials)).toEqual({
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
      async () =>
        await resolveVercelEgressPolicy({ egressAuth: egressAuth!, sessionKey: "sandbox" }).catch(
          (value) => value,
        ),
    );

    expect(isAuthorizationInterrupt(error)).toBe(true);
    expect(startAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        // The attempt id segment is a freshly minted ULID.
        callbackUrl: expect.stringMatching(
          /^https:\/\/app\.example\.com\/eve\/v1\/connections\/sandbox%3Asandbox%3Ar-d0c43d388506-0\/callback\/[0-9A-Z]{26}\/session%3Aauth$/,
        ),
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
      contextStorage.run(context, async () =>
        resolveVercelEgressPolicy({ egressAuth: egressAuth!, sessionKey: "sandbox" }),
      ),
    ).rejects.toMatchObject({ reason: "principal_required", retryable: false });
  });
});

const RULE_ID = vercelEgressRuleId("api.example.com", 0);
const DEMAND = { sandboxName: "sbx", token: "a".repeat(43) };

function onRequestEgressAuth(getToken: () => Promise<{ token: string }>): VercelEgressAuth {
  const { egressAuth } = extractVercelEgressAuth({
    authProxyBaseUrl: "https://eve.example.com",
    credentialResolution: "on-request",
    networkPolicy: {
      allow: {
        "api.example.com": [
          {
            auth: { getToken },
            transform: ({ token }: { token: string }) => [
              { headers: { authorization: `Bearer ${token}` } },
            ],
          },
        ],
      },
    },
  });
  return egressAuth!;
}

function mockSdkSandbox(markers: Map<string, string> = new Map()) {
  return {
    fs: {
      rm: vi.fn(async (path: string) => {
        markers.delete(path.split("/").at(-1)!);
      }),
    },
    name: "sbx",
    update: vi.fn(async () => {}),
  } as never;
}

describe("activateVercelEgressRules", () => {
  it("activates resolved credentials in the policy and clears the settled markers", async () => {
    const markers = new Map([[RULE_ID, DEMAND.token]]);
    const sandbox = mockSdkSandbox(markers);
    const egressAuth = onRequestEgressAuth(async () => ({ token: "tok" }));

    const credentials = await activateVercelEgressRules({
      demand: DEMAND,
      demandedRuleIds: [RULE_ID],
      egressAuth,
      heldCredentials: new Map(),
      ruleIds: [RULE_ID],
      sandbox,
      sessionKey: "activate-success",
    });

    expect([...credentials.keys()]).toEqual([RULE_ID]);
    expect(vi.mocked((sandbox as { update: unknown }).update)).toHaveBeenCalledWith({
      networkPolicy: egressAuth.buildPolicy(credentials, DEMAND),
    });
    expect(markers.size).toBe(0);
  });

  it("propagates authorization interrupts with markers and policy untouched", async () => {
    const markers = new Map([[RULE_ID, DEMAND.token]]);
    const sandbox = mockSdkSandbox(markers) as { update: ReturnType<typeof vi.fn> } & object;
    // Interactive strategy so the required error escalates to an interrupt.
    const { egressAuth } = extractVercelEgressAuth({
      authProxyBaseUrl: "https://eve.example.com",
      credentialResolution: "on-request",
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
                startAuthorization: async () => ({
                  challenge: { url: "https://provider.example/authorize" },
                }),
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
      async () =>
        await activateVercelEgressRules({
          demand: DEMAND,
          demandedRuleIds: [RULE_ID],
          egressAuth: egressAuth!,
          heldCredentials: new Map(),
          ruleIds: [RULE_ID],
          sandbox: sandbox as never,
          sessionKey: "activate-interrupt",
        }).catch((value) => value),
    );

    expect(isAuthorizationInterrupt(error)).toBe(true);
    expect(sandbox.update).not.toHaveBeenCalled();
    expect(markers.size).toBe(1);
  });

  it("fails closed on resolution errors: held credentials stay, markers clear", async () => {
    const markers = new Map([[RULE_ID, DEMAND.token]]);
    const sandbox = mockSdkSandbox(markers) as { update: ReturnType<typeof vi.fn> } & object;
    const egressAuth = onRequestEgressAuth(async () => ({ token: "tok" }));
    const held = new Map([[RULE_ID, { token: "held" }]]);

    await expect(
      activateVercelEgressRules({
        demand: DEMAND,
        demandedRuleIds: [RULE_ID],
        egressAuth,
        heldCredentials: held,
        ruleIds: ["r-000000000000-9"],
        sandbox: sandbox as never,
        sessionKey: "activate-failure",
      }),
    ).rejects.toThrow(/Unknown managed sandbox egress rule/);

    expect(sandbox.update).toHaveBeenCalledWith({
      networkPolicy: egressAuth.buildPolicy(held, DEMAND),
    });
    expect(markers.size).toBe(0);
  });

  it("reports demanded rules whose credentials stay unavailable after activation", async () => {
    const markers = new Map([[RULE_ID, DEMAND.token]]);
    const sandbox = mockSdkSandbox(markers) as { update: ReturnType<typeof vi.fn> } & object;
    const egressAuth = onRequestEgressAuth(async () => {
      throw new Error("provider unavailable");
    });

    await expect(
      activateVercelEgressRules({
        demand: DEMAND,
        demandedRuleIds: [RULE_ID],
        egressAuth,
        heldCredentials: new Map(),
        ruleIds: [RULE_ID],
        sandbox: sandbox as never,
        sessionKey: "activate-unavailable",
      }),
    ).rejects.toThrow(/remained unavailable for on-request rules: "api\.example\.com"/);

    // The trigger policy is reinstalled so a later request can re-demand.
    expect(sandbox.update).toHaveBeenCalledWith({
      networkPolicy: egressAuth.buildPolicy(new Map(), DEMAND),
    });
    expect(markers.size).toBe(0);
  });
});
