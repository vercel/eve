import { describe, expect, it } from "vitest";

import { prepareAuthoredWorkflowDirectives } from "./authored-workflow-directives.js";

const FILE = "/app/agent/tools/deploy.ts";

function toolModule(execute: string): string {
  return [
    'import { defineTool } from "eve/tools";',
    'import { z } from "zod";',
    "",
    "export default defineTool({",
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

  it("hoists the execute method of a plain object default export", async () => {
    const source = [
      "export default {",
      '  description: "d",',
      "  async execute(input) {",
      '    "use workflow";',
      "    return input;",
      "  },",
      "};",
      "",
    ].join("\n");

    const prepared = await prepareAuthoredWorkflowDirectives({ filePath: FILE, source });

    expect(prepared.source).toContain("  execute,\n};");
    expect(prepared.source).toContain('async function execute(input) {\n    "use workflow";');
  });

  it("keeps a referenced top-level workflow function as is", async () => {
    const source = [
      'import { defineTool } from "eve/tools";',
      'export default defineTool({ description: "d", inputSchema: {}, execute: deploy });',
      "async function deploy(input: unknown) {",
      '  "use workflow";',
      "  return input;",
      "}",
      "",
    ].join("\n");

    await expect(prepareAuthoredWorkflowDirectives({ filePath: FILE, source })).resolves.toEqual({
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
    ).rejects.toThrow(/module-level "use step" directive/u);
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
    const source = `export default { description: "d", async execute() { "use workflow"; return 1; } };\n`;

    await expect(prepareAuthoredWorkflowDirectives({ filePath: FILE, source })).rejects.toThrow(
      /"use workflow" in .* is not on its own line/u,
    );
  });

  it("rejects hoisting over an existing top-level execute binding", async () => {
    const source = `${toolModule(["  async execute() {", '    "use workflow";', "    return 1;", "  },"].join("\n"))}const execute = 1;\n`;

    await expect(prepareAuthoredWorkflowDirectives({ filePath: FILE, source })).rejects.toThrow(
      /declares a top-level "execute" binding/u,
    );
  });
});
