import { describe, expect, it } from "vitest";

import { defineSelfModificationConfig, resolveSelfModificationConfig } from "./config.js";

describe("self-modification configuration", () => {
  it("enables local editing by default and omits deployed changes", () => {
    expect(resolveSelfModificationConfig()).toEqual({ developmentEnabled: true });
  });

  it("accepts a typed Git source and review change", () => {
    const config = defineSelfModificationConfig({
      change: { behavior: "review", branch: "main" },
      development: { enabled: false },
      source: { git: { repository: "github.com/acme/agent" } },
    });

    expect(resolveSelfModificationConfig(config)).toEqual({
      developmentEnabled: false,
      pullRequests: {
        repository: { owner: "acme", targetBranch: "main", repo: "agent" },
      },
    });
  });

  it("requires source and change together", () => {
    expect(() =>
      defineSelfModificationConfig({ source: { git: { repository: "github.com/acme/agent" } } }),
    ).toThrow(/both source and change/u);
  });

  it("rejects unsupported source repositories", () => {
    expect(() =>
      defineSelfModificationConfig({
        change: { behavior: "review", branch: "main" },
        source: { git: { repository: "gitlab.com/acme/agent" } },
      }),
    ).toThrow(/github\.com\/owner\/repo/u);
  });
});
