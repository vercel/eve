import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverAuthoredWorkflowModules } from "./authored-workflow-modules.js";

let appRoot: string;

async function write(relativePath: string, source: string): Promise<string> {
  const filePath = join(appRoot, relativePath);
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, source);
  return filePath;
}

beforeEach(async () => {
  appRoot = await mkdtemp(join(tmpdir(), "eve-authored-workflows-"));
  await write("package.json", JSON.stringify({ name: "fixture-app", type: "module" }));
});

afterEach(async () => {
  await rm(appRoot, { force: true, recursive: true });
});

describe("discoverAuthoredWorkflowModules", () => {
  it("separates workflow modules from step-only modules and skips the rest", async () => {
    const tool = await write(
      "agent/tools/deploy.ts",
      `import { defineTool } from "eve/tools";
import { plan } from "../lib/plan.ts";
export default defineTool({
  description: "d",
  inputSchema: {},
  async execute(input) {
    "use workflow";
    return plan(input);
  },
});`,
    );
    const helper = await write(
      "agent/lib/plan.ts",
      `export async function plan(input) {
  "use step";
  return input;
}`,
    );
    await write(
      "agent/tools/plain.ts",
      `export default { description: "p", async execute() { return 1; } };`,
    );
    await write(
      "agent/lib/quoted.ts",
      `export const text = '"use workflow" is only a directive as a statement';`,
    );
    await write("node_modules/dep/index.js", `export async function f() { "use workflow"; }`);
    await write("dist/out.js", `export async function f() { "use step"; }`);
    await write("agent/README.md", `"use workflow"`);

    await expect(discoverAuthoredWorkflowModules(appRoot)).resolves.toEqual({
      directiveModules: [helper, tool],
      workflowModules: [tool],
    });
  });

  it("finds nothing without an application package.json", async () => {
    await rm(join(appRoot, "package.json"));
    await write("agent/tools/deploy.ts", `export async function run() { "use workflow"; }`);

    await expect(discoverAuthoredWorkflowModules(appRoot)).resolves.toEqual({
      directiveModules: [],
      workflowModules: [],
    });
  });

  it("reports an invalid directive placement as a build error", async () => {
    await write(
      "agent/tools/bad.ts",
      `export default {
  execute() {
    const inner = async () => { "use workflow"; };
    return inner();
  },
};`,
    );

    await expect(discoverAuthoredWorkflowModules(appRoot)).rejects.toThrow(/use workflow/);
  });
});
