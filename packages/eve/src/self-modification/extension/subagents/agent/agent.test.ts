import type { SessionAuthContext } from "#context/keys.js";
import { installLocalDevCapabilityEnvironment } from "#runtime/local-dev-capability.js";
import { afterEach, describe, expect, it } from "vitest";

import { defineSelfModificationAgent, type SelfModificationAgentOptions } from "./agent.js";

const serverUrl = "http://127.0.0.1:3000";
const localDeveloper: SessionAuthContext = {
  attributes: {},
  authenticator: "local-dev",
  principalId: "local-dev",
  principalType: "local-dev",
};
const vercelDeveloper: SessionAuthContext = {
  attributes: { environment: "development", user_id: "user_123" },
  authenticator: "oidc",
  issuer: "https://oidc.vercel.com/acme",
  principalId: "user_123",
  principalType: "user",
  subject: "user_123",
};
const chatUser: SessionAuthContext = {
  attributes: {},
  authenticator: "slack",
  principalId: "U123",
  principalType: "user",
};

/** The context a subagent's function reads, with the parent's model and principal. */
const contextWith = (
  model = "openai/gpt-6-luna-fast",
  current: SessionAuthContext | null = localDeveloper,
) =>
  ({
    channel: { kind: "unknown", metadata: {} },
    messages: async () => [],
    model: { id: model },
    session: { auth: { current, initiator: current }, id: "session" },
  }) as never;
const context = contextWith();

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
  it.each([
    { label: "the localDev() principal", principal: localDeveloper },
    { label: "the linked Vercel developer", principal: vercelDeveloper },
  ])("is available to $label on an eve dev host", async ({ principal }) => {
    await withDevHost(async () => {
      const agent = defineSelfModificationAgent({ config: { local: { enabled: true } } });

      await expect(
        Promise.resolve(agent.evaluate(contextWith(undefined, principal))),
      ).resolves.toMatchObject({
        model: "openai/gpt-6-luna-fast",
      });
    });
  });

  it.each([
    { label: "another authenticated user", principal: chatUser },
    { label: "a session without a principal", principal: null },
  ])("is not available to $label on an eve dev host", async ({ principal }) => {
    await withDevHost(async () => {
      const agent = defineSelfModificationAgent({ config: { local: { enabled: true } } });

      await expect(
        Promise.resolve(agent.evaluate(contextWith(undefined, principal))),
      ).resolves.toBeNull();
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
        const resolved = await agent.evaluate(contextWith(parent ?? undefined));

        expect(resolved).toMatchObject({ model });
        expect(resolved).toHaveProperty("reasoning", reasoning);
      });
    },
  );

  it("does not expose the editor when eve dev facilities are absent", async () => {
    process.env.EVE_DEV = "1";
    const agent = defineSelfModificationAgent({ config: { local: { enabled: true } } });

    await expect(Promise.resolve(agent.evaluate(context))).resolves.toBeNull();
  });

  it("honors local.enabled: false even when eve dev facilities are available", async () => {
    await withDevHost(async () => {
      const agent = defineSelfModificationAgent({ config: { local: { enabled: false } } });

      await expect(Promise.resolve(agent.evaluate(context))).resolves.toBeNull();
    });
  });
});
