import { describe, expect, it } from "vitest";

import {
  createCompiledSubagentNodeId,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "#compiler/compiled-agent-node-id.js";

describe("createCompiledSubagentNodeId", () => {
  it("preserves ordinary readable node paths", () => {
    const child = createCompiledSubagentNodeId(ROOT_COMPILED_AGENT_NODE_ID, "subagents/research");

    expect(child).toBe("subagents/research");
    expect(createCompiledSubagentNodeId(child, "subagents/review")).toBe(
      "subagents/research::subagents/review",
    );
  });

  it("encodes opaque delimiters injectively and reserves the root id", () => {
    const oneSegment = createCompiledSubagentNodeId(ROOT_COMPILED_AGENT_NODE_ID, "a::b");
    const twoSegments = createCompiledSubagentNodeId(
      createCompiledSubagentNodeId(ROOT_COMPILED_AGENT_NODE_ID, "a"),
      "b",
    );

    expect(oneSegment).toBe("a%3A%3Ab");
    expect(twoSegments).toBe("a::b");
    expect(oneSegment).not.toBe(twoSegments);
    expect(createCompiledSubagentNodeId(ROOT_COMPILED_AGENT_NODE_ID, "%3A")).toBe("%253A");
    expect(createCompiledSubagentNodeId(ROOT_COMPILED_AGENT_NODE_ID, "__root__")).toBe(
      "%5F%5Froot%5F%5F",
    );
  });
});
