import { describe, expect, it, vi } from "vitest";

import { recoverVercelUserNetworkPolicy } from "#execution/sandbox/bindings/vercel-base-runtime.js";
import {
  createSandboxNetworkPolicyControl,
  getSandboxNetworkCredentialControl,
  mergeSandboxNetworkCredentials,
  withSandboxNetworkCredentials,
} from "#execution/sandbox/network-policy.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";

const rule = [{ transform: [{ headers: { Authorization: "Basic token" } }] }];
const credentials = { "github.com": rule };

function control(
  userPolicy: SandboxNetworkPolicy,
  rejects?: (policy: SandboxNetworkPolicy) => boolean,
) {
  const applied: SandboxNetworkPolicy[] = [];
  const readUserPolicy = vi.fn(async () => userPolicy);
  const session = createSandboxNetworkPolicyControl({
    async apply(policy) {
      if (rejects?.(policy) === true) throw new Error("provider rejected the policy");
      applied.push(policy);
    },
    readUserPolicy,
  });
  return { applied, readUserPolicy, session };
}

describe("mergeSandboxNetworkCredentials", () => {
  it("keeps allow-all open and attaches the rules", () => {
    expect(mergeSandboxNetworkCredentials("allow-all", credentials)).toEqual({
      allow: { "*": [], "github.com": rule },
    });
  });

  it("keeps the user's hosts and subnets and replaces rules on credential hosts", () => {
    expect(
      mergeSandboxNetworkCredentials(
        { allow: ["github.com", "npmjs.org"], subnets: { deny: ["10.0.0.0/8"] } },
        credentials,
      ),
    ).toEqual({
      allow: { "github.com": rule, "npmjs.org": [] },
      subnets: { deny: ["10.0.0.0/8"] },
    });
  });
});

describe("sandbox network credentials", () => {
  it.each<[string, SandboxNetworkPolicy]>([
    ["deny-all", "deny-all"],
    ["a list without the host", { allow: ["npmjs.org"] }],
    ["subnets only", { subnets: { allow: ["10.0.0.0/8"] } }],
  ])("refuses a host outside %s without writing a policy", async (_, policy) => {
    const { applied, session } = control(policy);

    await expect(withSandboxNetworkCredentials(session, credentials, vi.fn())).rejects.toThrow(
      "does not allow github.com",
    );
    expect(applied).toEqual([]);
  });

  it("allows a host matched by a wildcard entry", async () => {
    const { applied, session } = control({ allow: ["*.github.com"] });

    await withSandboxNetworkCredentials(session, { "api.github.com": rule }, async () => {});

    expect(applied).toEqual([
      { allow: { "*.github.com": [], "api.github.com": rule } },
      { allow: ["*.github.com"] },
    ]);
  });

  it("restores the user's policy when the operation fails", async () => {
    const { applied, session } = control({ allow: ["github.com"] });

    await expect(
      withSandboxNetworkCredentials(session, credentials, async () => {
        throw new Error("fetch failed");
      }),
    ).rejects.toThrow("fetch failed");
    expect(applied.at(-1)).toEqual({ allow: ["github.com"] });
  });

  it("keeps credentials across a user setNetworkPolicy and restores that policy after", async () => {
    const { applied, readUserPolicy, session } = control("allow-all");

    await withSandboxNetworkCredentials(session, credentials, async () => {
      await session.setNetworkPolicy({ allow: ["github.com"] });
    });

    expect(applied).toEqual([
      { allow: { "*": [], "github.com": rule } },
      { allow: { "github.com": rule } },
      { allow: ["github.com"] },
    ]);
    expect(readUserPolicy).toHaveBeenCalledTimes(1);
  });

  it("refuses a sandbox without a network-policy binding", async () => {
    await expect(withSandboxNetworkCredentials({}, credentials, vi.fn())).rejects.toThrow(
      "mutable network policy",
    );
  });
});

describe("user network policy limits credentials", () => {
  it("drops a credential host the user's new policy no longer allows", async () => {
    const { applied, session } = control("allow-all");

    await withSandboxNetworkCredentials(session, credentials, async () => {
      await session.setNetworkPolicy({ allow: ["npmjs.org"] });
      await session.setNetworkPolicy("deny-all");
    });

    expect(applied).toEqual([
      { allow: { "*": [], "github.com": rule } },
      { allow: ["npmjs.org"] },
      "deny-all",
      "deny-all",
    ]);
  });

  it("keeps the previous policy when the provider rejects a setNetworkPolicy", async () => {
    const { applied, session } = control("allow-all", (policy) => policy === "allow-all");
    await session.setNetworkPolicy({ allow: ["github.com"] });

    await expect(session.setNetworkPolicy("allow-all")).rejects.toThrow("provider rejected");
    await withSandboxNetworkCredentials(session, credentials, async () => {});

    expect(applied).toEqual([
      { allow: ["github.com"] },
      { allow: { "github.com": rule } },
      { allow: ["github.com"] },
    ]);
  });

  it("brings back a longer-lived credential on the same host after a temporary one", async () => {
    const { applied, session } = control({ allow: ["github.com", "api.github.com"] });
    const persistent = [{ transform: [{ headers: { authorization: "Bearer persistent" } }] }];
    await getSandboxNetworkCredentialControl(session).add({
      "api.github.com": persistent,
      "github.com": persistent,
    });

    await withSandboxNetworkCredentials(session, credentials, async () => {});

    expect(applied.at(-2)).toEqual({
      allow: { "api.github.com": persistent, "github.com": rule },
    });
    expect(applied.at(-1)).toEqual({
      allow: { "api.github.com": persistent, "github.com": persistent },
    });
  });
});

describe("recoverVercelUserNetworkPolicy", () => {
  const redacted = [{ transform: [{ headers: { Authorization: "<redacted>" } }] }];

  it("treats a missing live policy as allow-all", () => {
    expect(recoverVercelUserNetworkPolicy(undefined, ["github.com"])).toBe("allow-all");
  });

  it("drops leftover rules on the credential hosts", () => {
    expect(
      recoverVercelUserNetworkPolicy(
        { allow: { "codeload.github.com": redacted, "github.com": redacted } },
        ["github.com", "codeload.github.com"],
      ),
    ).toEqual({ allow: { "codeload.github.com": [], "github.com": [] } });
  });

  it("refuses redacted header rules on other hosts, since their live values are unknown", () => {
    // Configured with token A, rotated to token B through setNetworkPolicy:
    // the live policy shows only the header name, so either value could be in force.
    expect(() =>
      recoverVercelUserNetworkPolicy({ allow: { "api.example.com": redacted, "github.com": [] } }, [
        "github.com",
      ]),
    ).toThrow("Vercel does not return their values");
  });
});
