import { afterEach, describe, expect, it, vi } from "vitest";

import { CODING_AGENT_ENV_MARKERS, isCodingAgentLaunch } from "./agent-detection.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isCodingAgentLaunch", () => {
  // The wrapper is a one-line unwrap of `@vercel/detect-agent`, so this pins
  // only our own contract: a scrubbed environment reads as a human launch, and
  // a single marker flips it. That negative case is what the marker-scrubbing
  // in the other tiers relies on. Detection across the full marker set is the
  // dependency's concern and is exercised end-to-end by the eve-init scenarios.
  it("reads a scrubbed environment as a human launch and a marker as a coding agent", async () => {
    for (const marker of CODING_AGENT_ENV_MARKERS) {
      vi.stubEnv(marker, undefined);
    }
    await expect(isCodingAgentLaunch()).resolves.toBe(false);

    vi.stubEnv("AI_AGENT", "claude");
    await expect(isCodingAgentLaunch()).resolves.toBe(true);
  });
});
