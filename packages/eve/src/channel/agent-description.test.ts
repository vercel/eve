import { expect, it } from "vitest";

import { describeCompiledAgent } from "#channel/agent-description.js";

it("describes only the tools invokeTool can run, sorted by name", () => {
  const tool = (name: string, extra: Record<string, unknown> = {}) => ({
    description: `${name} description`,
    hasExecute: true,
    inputSchema: { type: "object" },
    name,
    requiresApproval: false,
    sourceId: `source:${name}`,
    ...extra,
  });
  const manifest = {
    bindings: {
      "source:deploy": { owner: { kind: "application" } },
      "source:lookup": { owner: { kind: "extension" } },
      "source:load_skill": { owner: { feature: "skills", kind: "framework" } },
      "source:plan": { owner: { kind: "application" } },
      "source:remote": { owner: { kind: "application" } },
    },
    config: { description: "Runs the kennel.", name: "kennel" },
    tools: [
      tool("lookup", { outputSchema: { type: "object" } }),
      tool("deploy", { requiresApproval: true }),
      tool("load_skill"),
      tool("plan", { behavior: { handling: { kind: "workflow-tool" } } }),
      tool("remote", { hasExecute: false }),
    ],
  };

  expect(describeCompiledAgent(manifest as never)).toEqual({
    description: "Runs the kennel.",
    name: "kennel",
    tools: [
      {
        approval: true,
        description: "deploy description",
        inputSchema: { type: "object" },
        name: "deploy",
      },
      {
        approval: false,
        description: "lookup description",
        inputSchema: { type: "object" },
        name: "lookup",
        outputSchema: { type: "object" },
      },
    ],
  });
});
