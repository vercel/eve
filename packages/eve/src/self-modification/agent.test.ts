import { afterEach, describe, expect, it, vi } from "vitest";

import type { DynamicResolveContext } from "#dynamic/definition.js";

import { DEFAULT_SELF_MODIFICATION_MODEL, defineSelfModificationAgent } from "./agent.js";

const originalEveDev = process.env.EVE_DEV;
const originalGitHubToken = process.env.EVE_SELF_MODIFICATION_GITHUB_TOKEN;
const deployed = {
  deployed: {
    source: { git: { directory: ".", repository: "github.com/acme/agent" } },
    target: { branch: "main" },
    authorize: () => true,
    credentials: { pat: true },
  },
} as const;

afterEach(() => {
  if (originalEveDev === undefined) {
    delete process.env.EVE_DEV;
  } else {
    process.env.EVE_DEV = originalEveDev;
  }
  if (originalGitHubToken === undefined) {
    delete process.env.EVE_SELF_MODIFICATION_GITHUB_TOKEN;
  } else {
    process.env.EVE_SELF_MODIFICATION_GITHUB_TOKEN = originalGitHubToken;
  }
});

describe("defineSelfModificationAgent", () => {
  it("uses the default model", async () => {
    process.env.EVE_DEV = "1";

    const agent = defineSelfModificationAgent();
    const definition = await agent.events["session.started"]?.({}, {} as never);

    expect(definition).toMatchObject({
      description: expect.stringContaining(
        "investigate, diagnose, or optimize the agent's behavior from local traces",
      ),
      model: DEFAULT_SELF_MODIFICATION_MODEL,
    });
  });

  it("configures the subagent model", async () => {
    process.env.EVE_DEV = "1";

    const agent = defineSelfModificationAgent({ model: "openai/gpt-5" });
    const definition = await agent.events["session.started"]?.({}, {} as never);

    expect(definition).toMatchObject({ model: "openai/gpt-5" });
  });

  it("requires configured deployment and credential preflight", async () => {
    delete process.env.EVE_DEV;
    const agent = defineSelfModificationAgent({ config: deployed });
    const ctx = { channel: {}, session: { auth: { current: null, initiator: null } } } as never;
    await expect(agent.events["session.started"]?.({}, ctx)).resolves.toBeNull();

    process.env.EVE_SELF_MODIFICATION_GITHUB_TOKEN = "secret";
    const definition = await agent.events["session.started"]?.({}, ctx);
    expect(definition?.description).toContain("draft pull request");
    expect(definition?.description).toContain("non-secret answers");
  });

  it("authorizes the current principal from its channel family", async () => {
    delete process.env.EVE_DEV;
    process.env.EVE_SELF_MODIFICATION_GITHUB_TOKEN = "secret";
    const authorize = vi.fn(
      ({
        channel,
        principal,
      }: {
        channel: { kind?: string };
        principal: { principalId: string } | null;
      }) => channel.kind === "slack" && principal?.principalId === "slack:T1:U1",
    );
    const agent = defineSelfModificationAgent({
      config: { deployed: { ...deployed.deployed, authorize } },
    });
    const ctx = {
      channel: { kind: "slack" },
      session: {
        id: "session-1",
        auth: {
          current: {
            attributes: {},
            authenticator: "slack-webhook",
            principalId: "slack:T1:U1",
            principalType: "user",
          },
          initiator: null,
        },
      },
    } as DynamicResolveContext;

    expect(await agent.events["session.started"]?.({}, ctx)).toMatchObject({
      model: DEFAULT_SELF_MODIFICATION_MODEL,
    });
    expect(authorize).toHaveBeenCalledWith({
      channel: ctx.channel,
      principal: ctx.session.auth.current,
    });
    expect(
      await agent.events["turn.started"]?.(
        {},
        {
          ...ctx,
          session: { ...ctx.session, auth: { ...ctx.session.auth, current: null } },
        },
      ),
    ).toBeNull();
  });

  it("fails closed when authorization rejects or throws", async () => {
    delete process.env.EVE_DEV;
    process.env.EVE_SELF_MODIFICATION_GITHUB_TOKEN = "secret";
    const ctx = { channel: {}, session: { auth: { current: null, initiator: null } } } as never;

    for (const authorize of [
      () => false,
      () => {
        throw new Error("no");
      },
    ]) {
      const agent = defineSelfModificationAgent({
        config: { deployed: { ...deployed.deployed, authorize } },
      });
      expect(await agent.events["session.started"]?.({}, ctx)).toBeNull();
    }
  });

  it("keeps configured deployment local under eve dev", async () => {
    process.env.EVE_DEV = "1";
    process.env.EVE_SELF_MODIFICATION_GITHUB_TOKEN = "secret";
    const agent = defineSelfModificationAgent({ config: deployed });
    const definition = await agent.events["session.started"]?.({}, {} as never);
    expect(definition?.description).toContain("developer");
    expect(definition?.description).not.toContain("draft pull request");
  });
});
