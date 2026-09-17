import assert from "node:assert/strict";
import test from "node:test";

import { ConnectError, type ConnectTokenParams } from "@vercel/connect";
import type { SandboxSession } from "eve/sandbox";

(globalThis as Record<symbol, unknown>)[Symbol.for("eve.ext-config-scope")] =
  "eve-code-connect-authentication-test";
const { authenticateTurn } = await import("../../extension/lib/connect-authentication.ts");

test("does not broker GitHub credentials at turn start", async () => {
  let requestedSandbox = false;
  await authenticateTurn(
    { github: { connector: "github/acme-bot", org: "acme", broker: async () => {} } },
    async () => {
      requestedSandbox = true;
      return fakeSandbox([]);
    },
    async () => {
      throw new Error("GitHub tokens belong to the gh tool");
    },
  );
  assert.equal(requestedSandbox, false);
});

test("authenticates only the Vercel connector at turn start", async () => {
  const calls: { connector: string; params: ConnectTokenParams }[] = [];
  const policies: { allow: Record<string, unknown> }[] = [];
  await authenticateTurn(
    {
      github: { connector: "github/acme-bot", org: "acme", broker: async () => {} },
      vercel: { connector: "vercel/acme-bot", delivery: "firewall" },
    },
    async () => fakeSandbox(policies),
    async (connector, params) => {
      calls.push({ connector, params });
      return `${connector}-token`;
    },
  );

  assert.deepEqual(
    calls.map((call) => call.connector),
    ["vercel/acme-bot"],
  );
  assert.deepEqual(calls[0]?.params, { subject: { type: "app" } });
  assert.deepEqual(Object.keys(policies.at(-1)?.allow ?? {}).sort(), [
    "*",
    "api.vercel.com",
    "vercel.com",
  ]);
});

test("does nothing when no connector is configured", async () => {
  let requestedSandbox = false;
  await authenticateTurn({}, async () => {
    requestedSandbox = true;
    return fakeSandbox([]);
  });
  assert.equal(requestedSandbox, false);
});

test("Connect errors fail with the connector UID", async () => {
  await assert.rejects(
    authenticateTurn(
      { vercel: { connector: "vercel/broken", delivery: "firewall" } },
      async () => fakeSandbox([]),
      async () => {
        throw new ConnectError("grant denied");
      },
    ),
    /Connect rejected the token request for "vercel\/broken": grant denied/u,
  );
});

function fakeSandbox(policies: { allow: Record<string, unknown> }[]): SandboxSession {
  return {
    id: `sandbox-${crypto.randomUUID()}`,
    async setNetworkPolicy(policy: Parameters<SandboxSession["setNetworkPolicy"]>[0]) {
      policies.push(policy as { allow: Record<string, unknown> });
    },
  } as SandboxSession;
}
