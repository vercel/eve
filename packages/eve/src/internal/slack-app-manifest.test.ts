import { describe, expect, it } from "vitest";

import { collectSlackAppManifests, slackAppManifestPath } from "#internal/slack-app-manifest.js";

describe("Slack app manifest artifacts", () => {
  it("derives separate paths from channel source paths", () => {
    expect(slackAppManifestPath("channels/slack.ts")).toBe(
      "channels/slack.slack-app-manifest.json",
    );
    expect(slackAppManifestPath("channels/support/slack.tsx")).toBe(
      "channels/support/slack.slack-app-manifest.json",
    );
  });

  it("collects native manifests without Connect metadata", () => {
    const manifests = collectSlackAppManifests({
      channelRoutes: {
        effective: [
          {
            adapterKind: "slack",
            logicalPath: "channels/support.ts",
            slackAppManifest: { display_information: { name: "support" } },
          },
          {
            adapterKind: "custom",
            logicalPath: "channels/custom.ts",
            slackAppManifest: { display_information: { name: "custom" } },
          },
        ],
      },
    } as const);

    expect(Object.fromEntries(manifests)).toEqual({
      "channels/support.slack-app-manifest.json": {
        display_information: { name: "support" },
      },
    });
  });
});
