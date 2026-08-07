import { describe, expect, it } from "vitest";

import {
  emptyRegistrySetupCompletion,
  mergeRegistrySetupCompletions,
  registrySetupCompletionFacts,
} from "./registry-setup-completion.js";

describe("registry setup completion", () => {
  it("merges facts and deduplicates production destinations by URL", () => {
    const completion = mergeRegistrySetupCompletions(
      emptyRegistrySetupCompletion(),
      {
        facts: [{ label: "Workspace", value: "Acme" }],
        deployment: {
          required: true,
          productionDestinations: [{ label: "Open Slack", url: "https://slack.com/app" }],
        },
      },
      {
        facts: [{ label: "Channel", value: "support" }],
        deployment: {
          required: true,
          productionDestinations: [{ label: "Slack", url: "https://slack.com/app" }],
        },
      },
    );

    expect(completion).toEqual({
      facts: [
        { label: "Workspace", value: "Acme" },
        { label: "Channel", value: "support" },
      ],
      deployment: {
        required: true,
        productionDestinations: [{ label: "Open Slack", url: "https://slack.com/app" }],
      },
    });
    expect(registrySetupCompletionFacts(completion)).toEqual([
      { label: "Workspace", value: "Acme" },
      { label: "Channel", value: "support" },
      { label: "Open Slack", value: "https://slack.com/app", kind: "url" },
    ]);
  });

  it("does not repeat destinations already represented by URL facts", () => {
    const completion = {
      facts: [{ label: "Dashboard", value: "https://example.com", kind: "url" as const }],
      deployment: {
        required: true as const,
        productionDestinations: [{ label: "Open dashboard", url: "https://example.com" }],
      },
    };

    expect(registrySetupCompletionFacts(completion)).toEqual(completion.facts);
  });
});
