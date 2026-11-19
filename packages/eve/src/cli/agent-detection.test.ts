import { afterEach, describe, expect, it, vi } from "vitest";

import { CODING_AGENT_ENV_MARKERS } from "#setup/primitives/coding-agent-env.js";

import { isCodingAgentLaunch } from "./agent-detection.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isCodingAgentLaunch", () => {
  it("reads a scrubbed environment as a human launch and a marker as a coding agent", async () => {
    for (const marker of CODING_AGENT_ENV_MARKERS) {
      vi.stubEnv(marker, undefined);
    }
    await expect(isCodingAgentLaunch()).resolves.toBe(false);

    vi.stubEnv("AI_AGENT", "claude");
    await expect(isCodingAgentLaunch()).resolves.toBe(true);
  });
});
