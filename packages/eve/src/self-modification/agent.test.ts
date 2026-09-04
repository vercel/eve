import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_SELF_MODIFICATION_MODEL, defineSelfModificationAgent } from "./agent.js";

const originalEveDev = process.env.EVE_DEV;
const originalGitHubToken = process.env.EVE_SELF_MODIFICATION_GITHUB_TOKEN;
const deployed = {
  deployed: {
    source: { git: { directory: ".", repository: "github.com/acme/agent" } },
    target: { branch: "main" },
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

    expect(definition).toMatchObject({ model: DEFAULT_SELF_MODIFICATION_MODEL });
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
    expect(agent.events["session.started"]?.({}, {} as never)).toBeNull();

    process.env.EVE_SELF_MODIFICATION_GITHUB_TOKEN = "secret";
    const definition = await agent.events["session.started"]?.({}, {} as never);
    expect(definition?.description).toContain("draft pull request");
    expect(definition?.description).toContain("non-secret answers");
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
