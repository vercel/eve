import { describe, expect, it } from "vitest";

import { mergeRegistrySetupCompletions } from "./registry-setup-completion.js";

describe("registry setup completion", () => {
  it("merges facts and preserves the deployment requirement", () => {
    expect(
      mergeRegistrySetupCompletions(
        { facts: [{ label: "Workspace", value: "Acme" }] },
        {
          facts: [{ label: "Open Slack", value: "https://slack.com/app", kind: "url" }],
          deploymentRequired: true,
        },
      ),
    ).toEqual({
      facts: [
        { label: "Workspace", value: "Acme" },
        { label: "Open Slack", value: "https://slack.com/app", kind: "url" },
      ],
      deploymentRequired: true,
    });
  });
});
