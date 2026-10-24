import { describe, expect, it } from "vitest";

import { deployedSelfModificationConfigSchema } from "./config-schema.js";

function validate(config: unknown) {
  const result = deployedSelfModificationConfigSchema["~standard"].validate(config);
  if (result instanceof Promise) throw new Error("Expected synchronous validation.");
  return result;
}

describe("deployed self-modification configuration", () => {
  const deployed = {
    authorize: () => true,
    baseBranch: "release/production",
    directory: "apps/weather",
    github: { connector: "github/agent-author", repository: "acme/agents" },
  };
  const repository = (value: string) => ({
    ...deployed,
    github: { ...deployed.github, repository: value },
  });

  it.each([
    deployed,
    { ...deployed, directory: "." },
    { ...deployed, model: "openai/gpt-5.4", reasoning: "high" },
  ])("accepts %j", (config) => {
    expect(validate(config).issues).toBeUndefined();
  });

  it("defaults the directory to the repository root and the base branch to main", () => {
    const { authorize, github } = deployed;
    const result = validate({ authorize, github });
    expect(result.issues).toBeUndefined();
    expect(result).toMatchObject({
      value: { baseBranch: "main", directory: ".", github },
    });
  });

  it.each([
    ["repository", repository("github.com/acme/agents"), "owner/repo"],
    ["repository owner", repository("-acme/agents"), "owner/repo"],
    ["owner characters", repository("acme_corp/agents"), "owner/repo"],
    ["top-level repository", { ...deployed, repository: "acme/agents" }, "Unrecognized key"],
    ["directory", { ...deployed, directory: "../agents" }, "safe repository-relative"],
    ["base branch", { ...deployed, baseBranch: "refs/heads/main" }, "not a full Git ref"],
    ["lock ref", { ...deployed, baseBranch: "main.lock" }, "valid branch name"],
    ["connector", { ...deployed, github: { ...deployed.github, connector: "" } }, "connector"],
    [
      "missing repository",
      { ...deployed, github: { connector: "github/agent-author" } },
      "github.repository",
    ],
    ["authorization", { ...deployed, authorize: true }, "authorize must be a function"],
    [
      "missing authorization",
      { ...deployed, authorize: undefined },
      "authorize must be a function",
    ],
    ["unknown key", { ...deployed, target: { branch: "main" } }, "target"],
    ["model", { ...deployed, model: 42 }, "model"],
    ["legacy deployed wrapper", { deployed }, "deployed"],
  ])("rejects an invalid %s", (_name, config, message) => {
    const issues = validate(config).issues ?? [];
    expect(
      issues.map((issue) => `${issue.path?.join(".")}: ${issue.message}`).join("\n"),
    ).toContain(message);
  });
});
