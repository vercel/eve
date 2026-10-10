import type { ResolveContext as DynamicResolveContext } from "#dynamic/definition.js";
import {
  installLocalDevCapabilityEnvironment,
  withLocalDevRequestScope,
} from "#runtime/local-dev-capability.js";
import { stampDevelopmentClientAddress } from "#internal/nitro/dev-client-address.js";
import { DEVELOPMENT_WORKFLOW_SECRET_ENV } from "#internal/workflow/development-world-protocol.js";
import { afterEach, describe, expect, it } from "vitest";

import { defineSelfModificationAgent, type SelfModificationAgentOptions } from "./agent.js";

const serverUrl = "http://127.0.0.1:3000";
const context: DynamicResolveContext = {
  abortSignal: new AbortController().signal,
  channel: {},
  facts: [],
  session: { auth: { current: null, initiator: null }, id: "session" },
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

      await expect(agent.resolve(null, context)).resolves.toMatchObject({
        model: "openai/gpt-6-luna-fast",
        reasoning: "high",
      });
    });
  });

  it.each<{
    label: string;
    options: SelfModificationAgentOptions;
    parent: string | null;
    model: string;
    reasoning: string | undefined;
  }>([
    {
      label: "explicit model",
      options: { model: "anthropic/claude-sonnet-5" },
      parent: null,
      model: "anthropic/claude-sonnet-5",
      reasoning: undefined,
    },
    {
      label: "parent model",
      options: {},
      parent: "openai/gpt-6-luna-fast",
      model: "openai/gpt-6-luna-fast",
      reasoning: undefined,
    },
    {
      label: "explicit reasoning",
      options: { reasoning: "low" },
      parent: null,
      model: "openai/gpt-6-luna-fast",
      reasoning: "low",
    },
    {
      label: "provider-default reasoning",
      options: { reasoning: "provider-default" },
      parent: null,
      model: "openai/gpt-6-luna-fast",
      reasoning: "provider-default",
    },
  ])(
    "preserves $label instead of forcing fallback reasoning",
    async ({ options, parent, model, reasoning }) => {
      await withDevHost(async () => {
        const agent = defineSelfModificationAgent({
          ...options,
          config: { local: { enabled: true } },
        });
        const resolved = await agent.resolve(parent, context);

        expect(resolved).toMatchObject({ model });
        expect(resolved).toHaveProperty("reasoning", reasoning);
      });
    },
  );

  it("is available to a direct remote request on an eve dev host", async () => {
    await withDevHost(async () => {
      const secret = "test-secret";
      process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV] = secret;
      const headers = new Headers();
      stampDevelopmentClientAddress(headers, "203.0.113.7", secret);

      await withLocalDevRequestScope(new Request(serverUrl, { headers }), async () => {
        const agent = defineSelfModificationAgent({ config: { local: { enabled: true } } });

        await expect(agent.resolve(null, context)).resolves.not.toBeNull();
      });
    });
  });

  it("does not expose the editor when eve dev facilities are absent", async () => {
    process.env.EVE_DEV = "1";
    const agent = defineSelfModificationAgent({ config: { local: { enabled: true } } });

    await expect(agent.resolve(null, context)).resolves.toBeNull();
  });

  it("honors local.enabled: false even when eve dev facilities are available", async () => {
    await withDevHost(async () => {
      const agent = defineSelfModificationAgent({ config: { local: { enabled: false } } });

      await expect(agent.resolve(null, context)).resolves.toBeNull();
    });
  });
});
