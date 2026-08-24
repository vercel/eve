import { describe, expect, it } from "vitest";

import agent from "#framework-sources/agent.js";
import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";

describe("framework agent config source", () => {
  it("exports the immutable eve default through the public definition shape", () => {
    expect(agent).toEqual({ model: DEFAULT_AGENT_MODEL_ID });
    expect(Object.isFrozen(agent)).toBe(true);
  });
});
