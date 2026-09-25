import type { DynamicResolveContext } from "#dynamic/definition.js";
import {
  installLocalDevCapabilityEnvironment,
  withLocalDevRequestScope,
} from "#runtime/local-dev-capability.js";
import { stampDevelopmentClientAddress } from "#internal/nitro/dev-client-address.js";
import { DEVELOPMENT_WORKFLOW_SECRET_ENV } from "#internal/workflow/development-world-protocol.js";
import { afterEach, describe, expect, it } from "vitest";

import { defineSelfModificationAgent } from "./agent.js";

const serverUrl = "http://127.0.0.1:3000";
const context: DynamicResolveContext = {
  channel: {},
  messages: [],
  model: null,
  session: { context: {}, auth: { current: null, initiator: null }, id: "session" },
};

const savedEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnvironment };
});

async function withDevHost<T>(callback: () => Promise<T>): Promise<T> {
  process.env.EVE_DEV = "1";
  const restore = installLocalDevCapabilityEnvironment({ appRoot: "/workspace/app", serverUrl });
  try {
    return await callback();
  } finally {
    restore();
  }
}

describe("self-modification local agent", () => {
  it("is available on an eve dev host without a request scope", async () => {
    await withDevHost(async () => {
      const agent = defineSelfModificationAgent({ config: { local: { enabled: true } } });

      await expect(agent.events["turn.started"]?.({}, context)).resolves.not.toBeNull();
    });
  });

  it("is available to a direct remote request on an eve dev host", async () => {
    await withDevHost(async () => {
      const secret = "test-secret";
      process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV] = secret;
      const headers = new Headers();
      stampDevelopmentClientAddress(headers, "203.0.113.7", secret);

      await withLocalDevRequestScope(new Request(serverUrl, { headers }), async () => {
        const agent = defineSelfModificationAgent({ config: { local: { enabled: true } } });

        await expect(agent.events["turn.started"]?.({}, context)).resolves.not.toBeNull();
      });
    });
  });

  it("does not expose the editor when eve dev facilities are absent", async () => {
    process.env.EVE_DEV = "1";
    const agent = defineSelfModificationAgent({ config: { local: { enabled: true } } });

    await expect(agent.events["turn.started"]?.({}, context)).resolves.toBeNull();
  });

  it("honors local.enabled: false even when eve dev facilities are available", async () => {
    await withDevHost(async () => {
      const agent = defineSelfModificationAgent({ config: { local: { enabled: false } } });

      await expect(agent.events["turn.started"]?.({}, context)).resolves.toBeNull();
    });
  });
});
