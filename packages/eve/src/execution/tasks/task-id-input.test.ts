import { describe, expect, it } from "vitest";
import { z } from "zod";

import { withTaskIdInput } from "#execution/tasks/task-id-input.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";

function agentTool(name: string): HarnessToolDefinition {
  return {
    behavior: {
      availability: [],
      handling: {
        kind: "dispatch",
        target: {
          kind: name === "agent" ? "self-agent-call" : "subagent-call",
          nodeId: "node_1",
          subagentName: name,
        },
      },
    },
    description: "Delegate work.",
    inputSchema: z.object({ message: z.string() }),
    name,
  };
}

describe("agent call label", () => {
  it.each([
    [
      "names a subagent before the first sentence of its brief",
      "researcher",
      "Find the March incidents. Include timelines.\nThen rank them.",
      "researcher: Find the March incidents.",
    ],
    [
      "shows the brief alone for the agent's own copy",
      "agent",
      "\nInvestigate issue #4035. Summarize the report.",
      "Investigate issue #4035.",
    ],
    [
      "keeps versions and abbreviations inside one sentence",
      "agent",
      "On eve@0.58.1 the build fails, e.g. with an extension mounted. Reproduce it.",
      "On eve@0.58.1 the build fails, e.g. with an extension mounted.",
    ],
    [
      "keeps a leading list marker with its sentence",
      "agent",
      "1. Reproduce the build failure on main. Then bisect.",
      "1. Reproduce the build failure on main.",
    ],
    [
      "keeps a number after an abbreviation inside one sentence",
      "agent",
      "See PR No. 4035 for details. Then review it.",
      "See PR No. 4035 for details.",
    ],
    ["falls back to the agent's name for an empty brief", "agent", "  \n", "agent"],
  ])("%s", (_name, tool, message, expected) => {
    expect(withTaskIdInput(agentTool(tool)).label?.start?.({ message })).toBe(expected);
  });
});
