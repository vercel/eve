import { describe, expect, it } from "vitest";

import {
  parseCodeModeWorkflowInput,
  serializeCodeModeWorkflowInput,
  type CodeModeToolCatalogEntry,
} from "#execution/code-mode/schema.js";

const entry: CodeModeToolCatalogEntry = {
  name: "add",
  description: "Add numbers.",
  inputSchema: { type: "object" },
  outputSchema: null,
  target: "tool",
};

function input(...toolCatalog: readonly CodeModeToolCatalogEntry[]) {
  return { js: "return 1;", maxSubagents: 10, toolCatalog };
}

describe("code_mode workflow input", () => {
  it("round-trips workflow targets with their workflow id and omits it elsewhere", () => {
    const workflow: CodeModeToolCatalogEntry = {
      ...entry,
      name: "plan",
      target: "workflow",
      workflowId: "workflow//app//plan",
    };
    const serialized = serializeCodeModeWorkflowInput(input(entry, workflow));
    expect(serialized.toolCatalog).toEqual([
      { ...entry },
      { ...entry, name: "plan", target: "workflow", workflowId: "workflow//app//plan" },
    ]);
    expect((serialized.toolCatalog as object[])[0]).not.toHaveProperty("workflowId");
    expect(parseCodeModeWorkflowInput(JSON.parse(JSON.stringify(serialized)))).toEqual(
      input(entry, workflow),
    );
  });

  it("rejects a workflow target without a workflow id", () => {
    const serialized = serializeCodeModeWorkflowInput(
      input({ ...entry, name: "plan", target: "workflow" }),
    );
    expect(() => parseCodeModeWorkflowInput(serialized)).toThrow(
      '"plan" targets a workflow without a workflowId',
    );
  });

  it("rejects a workflow id on a non-workflow target", () => {
    const serialized = serializeCodeModeWorkflowInput(
      input({ ...entry, workflowId: "workflow//app//add" }),
    );
    expect(() => parseCodeModeWorkflowInput(serialized)).toThrow(
      '"add" carries a workflowId for a non-workflow target',
    );
  });

  it("rejects unknown targets", () => {
    expect(() =>
      parseCodeModeWorkflowInput({
        ...input(),
        toolCatalog: [{ ...entry, target: "remote" }],
      }),
    ).toThrow("catalog entry is invalid");
  });
});
