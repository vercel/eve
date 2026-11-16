import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { routeAuth } from "eve/channels/auth";
import type { EveChannelConfig } from "eve/channels/eve";

let config: EveChannelConfig | undefined;
mock.module("eve/channels/eve", {
  namedExports: {
    eveChannel: (options: EveChannelConfig) => {
      config = options;
      return options;
    },
  },
});
await import("./eve.js");
assert.ok(config);
const { auth } = config;

const withEnvironment = async (
  values: Record<string, string | undefined>,
  run: () => Promise<void>
) => {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]])
  );
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

test("trusted local auth grants user-scoped tools and request-local agent info", async () => {
  await withEnvironment(
    { EVE_DEV: "1", VERCEL: undefined, VERCEL_ENV: undefined },
    async () => {
      const result = await routeAuth(
        new Request("http://localhost:2000/eve/v1/info"),
        auth
      );
      assert.ok(!(result instanceof Response));
      assert.equal(result.principalType, "user");
      assert.equal(result.principalId, "local-dev");
      assert.equal(result.allowAgentInfo, true);
      assert.equal(result.allowToolStubs, undefined);

      const refused = await routeAuth(
        new Request("http://localhost:2000/eve/v1/info", {
          headers: { origin: "https://untrusted.example" },
        }),
        auth
      );
      assert.ok(refused instanceof Response);
      assert.equal(refused.status, 401);
    }
  );
});

test("production requests cannot acquire the local user or agent-info grant", async () => {
  await withEnvironment(
    { EVE_DEV: undefined, VERCEL: "1", VERCEL_ENV: "production" },
    async () => {
      const result = await routeAuth(
        new Request("http://localhost:2000/eve/v1/info", {
          headers: { "x-eve-dev": "1" },
        }),
        auth
      );
      assert.ok(result instanceof Response);
      assert.equal(result.status, 401);
    }
  );
});
