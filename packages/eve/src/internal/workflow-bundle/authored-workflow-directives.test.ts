import { describe, expect, it } from "vitest";

import { prepareAuthoredWorkflowDirectives } from "./authored-workflow-directives.js";

const FILE = "/app/agent/tools/deploy.ts";

function toolModule(execute: string): string {
  return [
    'import { defineWorkflowTool } from "eve/tools";',
    'import { z } from "zod";',
    "",
    "export default defineWorkflowTool({",
    '  description: "Deploy",',
    "  inputSchema: z.object({ service: z.string() }),",
    execute,
    "  toModelOutput: (output) => output,",
    "});",
    "",
    "async function planDeploy(service: string): Promise<string> {",
    '  "use step";',
    "  return service;",
    "}",
    "",
  ].join("\n");
}

describe("prepareAuthoredWorkflowDirectives", () => {
  it("leaves modules without directives untouched", async () => {
    const source = 'export const value = "use step is only text here";\n';
    await expect(prepareAuthoredWorkflowDirectives({ filePath: FILE, source })).resolves.toEqual({
      hasDirectives: false,
      hasWorkflowDirective: false,
      source,
    });
  });

  it("hoists a shorthand execute method into a top-level declaration", async () => {
    const source = toolModule(
      [
        "  async execute({ service }: { service: string }, ctx: ToolContext): Promise<{ ok: boolean }> {",
        '    "use workflow";',
        "    const plan = await planDeploy(service);",
        "    return { ok: plan.length > 0 };",
        "  },",
      ].join("\n"),
    );

    const prepared = await prepareAuthoredWorkflowDirectives({ filePath: FILE, source });

    expect(prepared.hasDirectives).toBe(true);
    expect(prepared.executeWorkflow).toBe("execute");
    expect(prepared.source).toContain("  execute,\n  toModelOutput: (output) => output,");
    expect(prepared.source).toContain(
      "async function execute({ service }: { service: string }, ctx: ToolContext): Promise<{ ok: boolean }> {\n" +
        '    "use workflow";',
    );
    expect(prepared.source).not.toContain("async execute(");
  });

  it("hoists an arrow function execute property", async () => {
    const source = toolModule(
      [
        "  execute: async (input: { service: string }) => {",
        '    "use workflow";',
        "    return input;",
        "  },",
      ].join("\n"),
    );

    const prepared = await prepareAuthoredWorkflowDirectives({ filePath: FILE, source });

    expect(prepared.source).toContain(
      'async function execute(input: { service: string }) {\n    "use workflow";\n    return input;\n  }',
    );
    expect(prepared.source).toContain("  execute,\n");
  });

  it("hoists a function expression execute property", async () => {
    const source = toolModule(
      [
        "  execute: async function (input: { service: string }) {",
        '    "use workflow";',
        "    return input;",
        "  },",
      ].join("\n"),
    );

    const prepared = await prepareAuthoredWorkflowDirectives({ filePath: FILE, source });

    expect(prepared.source).toContain(
      'async function execute(input: { service: string }) {\n    "use workflow";',
    );
  });

  it("rejects a workflow executor on a bare tool object", async () => {
    const source = 'export default { async execute() {\n"use workflow";\nreturn 1; } };';
    await expect(prepareAuthoredWorkflowDirectives({ filePath: FILE, source })).rejects.toThrow(
      "Workflow executors require defineWorkflowTool()",
    );
  });

  it("makes a workflow tool durable without a directive", async () => {
    const source = toolModule("async execute(input) { return input; },");
    const prepared = await prepareAuthoredWorkflowDirectives({ filePath: FILE, source });
    expect(prepared).toMatchObject({ executeWorkflow: "execute", hasWorkflowDirective: true });
    expect(prepared.source).toContain('"use workflow";');
  });

  it.each(["async (input) => input", "async () => ({ ok: true })"])(
    "compiles an expression executor: %s",
    async (execute) => {
      const source = `import { defineWorkflowTool } from "eve/tools";\nexport default defineWorkflowTool({ execute: ${execute} });`;
      const prepared = await prepareAuthoredWorkflowDirectives({ filePath: FILE, source });
      expect(prepared).toMatchObject({ executeWorkflow: "execute", hasWorkflowDirective: true });
      expect(prepared.source).toContain('"use workflow";');
      expect(prepared.source).toContain("return (");
    },
  );

  it.each([
    ['import { defineWorkflowTool as durable } from "eve/tools";', "durable"],
    ['import * as tools from "eve/tools";', "tools.defineWorkflowTool"],
  ])("recognizes imported aliases: %s", async (binding, definer) => {
    const source = `${binding}\nexport default ${definer}({ async execute(input) { return input; } });`;
    await expect(
      prepareAuthoredWorkflowDirectives({ filePath: FILE, source }),
    ).resolves.toMatchObject({ executeWorkflow: "execute", hasWorkflowDirective: true });
  });

  it("marks a referenced local async function as the workflow executor", async () => {
    const source =
      'import { defineWorkflowTool } from "eve/tools";\nexport default defineWorkflowTool({ execute: deploy });\nasync function deploy(input) { return input; }';
    await expect(
      prepareAuthoredWorkflowDirectives({ filePath: FILE, source }),
    ).resolves.toMatchObject({ executeWorkflow: "deploy", hasWorkflowDirective: true });
  });

  it.each(["execute() { return 1; }", "execute: imported"])(
    "rejects an executor it cannot compile: %s",
    async (execute) => {
      const source = `import { defineWorkflowTool } from "eve/tools";\nexport default defineWorkflowTool({ ${execute} });`;
      await expect(prepareAuthoredWorkflowDirectives({ filePath: FILE, source })).rejects.toThrow(
        "requires an async execute body or a local top-level async function reference",
      );
    },
  );

  it("rejects use workflow on defineTool", async () => {
    const source = toolModule('async execute() {\n"use workflow";\nreturn 1; },').replaceAll(
      "defineWorkflowTool",
      "defineTool",
    );
    await expect(prepareAuthoredWorkflowDirectives({ filePath: FILE, source })).rejects.toThrow(
      "Workflow executors require defineWorkflowTool()",
    );
  });

  it("keeps a referenced top-level workflow function as is", async () => {
    const source = [
      'import { defineWorkflowTool } from "eve/tools";',
      'export default defineWorkflowTool({ description: "d", inputSchema: {}, execute: deploy });',
      "async function deploy(input: unknown) {",
      '  "use workflow";',
      "  return input;",
      "}",
      "",
    ].join("\n");

    await expect(prepareAuthoredWorkflowDirectives({ filePath: FILE, source })).resolves.toEqual({
      executeWorkflow: "deploy",
      hasDirectives: true,
      hasWorkflowDirective: true,
      source,
    });
  });

  it("rejects a module-level directive", async () => {
    await expect(
      prepareAuthoredWorkflowDirectives({
        filePath: FILE,
        source: '"use step";\nexport const value = 1;\n',
      }),
    ).rejects.toThrow(/"use step" in .* is a module-level directive/u);
  });

  it("rejects a directive on a nested or anonymous function", async () => {
    await expect(
      prepareAuthoredWorkflowDirectives({
        filePath: FILE,
        source: 'const run = async () => {\n  "use step";\n  return 1;\n};\nexport { run };\n',
      }),
    ).rejects.toThrow(/marks an arrow function/u);

    await expect(
      prepareAuthoredWorkflowDirectives({
        filePath: FILE,
        source: [
          "export async function outer() {",
          "  async function inner() {",
          '    "use step";',
          "  }",
          "  return inner();",
          "}",
          "",
        ].join("\n"),
      }),
    ).rejects.toThrow(/marks the nested function "inner"/u);
  });

  it("rejects a directive on a synchronous declaration", async () => {
    await expect(
      prepareAuthoredWorkflowDirectives({
        filePath: FILE,
        source: 'export function ping() {\n  "use step";\n  return 1;\n}\n',
      }),
    ).rejects.toThrow(/is not async/u);
  });

  it("rejects a step directive on the execute method", async () => {
    await expect(
      prepareAuthoredWorkflowDirectives({
        filePath: FILE,
        source: toolModule(
          ["  async execute() {", '    "use step";', "    return 1;", "  },"].join("\n"),
        ),
      }),
    ).rejects.toThrow(/"use step".*marks the default export's "execute" method/u);
  });

  it("rejects a directive the SDK's line-based pre-scan cannot see", async () => {
    const source = `export async function standalone() { "use workflow"; return 1; }\n`;

    await expect(prepareAuthoredWorkflowDirectives({ filePath: FILE, source })).rejects.toThrow(
      /"use workflow" in .* is not on its own line/u,
    );
  });

  it("rejects hoisting over an existing top-level execute binding", async () => {
    const source = `${toolModule(["  async execute() {", '    "use workflow";', "    return 1;", "  },"].join("\n"))}const execute = 1;\n`;

    await expect(prepareAuthoredWorkflowDirectives({ filePath: FILE, source })).rejects.toThrow(
      /also declares a top-level "execute" binding/u,
    );
  });
});
