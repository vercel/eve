import { describe, expect, it } from "vitest";

import { CODING_AGENT_ENV_MARKERS, withoutCodingAgentMarkers } from "./coding-agent-env.js";

describe("withoutCodingAgentMarkers", () => {
  it("drops every coding-agent launch marker while preserving the rest", () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PATH: "/usr/bin",
      CLAUDECODE: "1",
      CODEX_THREAD_ID: "abc",
      HOME: "/home/me",
    };
    const cleaned = withoutCodingAgentMarkers(env);
    expect(cleaned).toEqual({ NODE_ENV: "test", PATH: "/usr/bin", HOME: "/home/me" });
    for (const marker of CODING_AGENT_ENV_MARKERS) {
      expect(marker in cleaned).toBe(false);
    }
  });

  it("does not mutate the input", () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", CLAUDECODE: "1" };
    withoutCodingAgentMarkers(env);
    expect(env.CLAUDECODE).toBe("1");
  });
});
