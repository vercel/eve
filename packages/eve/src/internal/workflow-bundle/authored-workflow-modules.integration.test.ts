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
  it.each(["agent", "agent/subagents/researcher", "custom-agent"])(
    "skips sandbox workspace source under %s",
    async (agentRoot) => {
      await write(
        `${agentRoot}/sandbox/workspace/eve-source/src/tools/framework/agent.js`,
        `export default { execute() { "use workflow"; return 1; } };`,
      );
      await write(
        `${agentRoot}/sandbox/workspace/eve-source/src/flow.js`,
        `import { missing } from "uninstalled-sandbox-dependency";
export async function copiedWorkflow() { "use workflow"; return missing(); }`,
      );
      await write(
        `${agentRoot}/sandbox/workspace/eve-source/src/step.js`,
        `export async function copiedStep() { "use step"; return 1; }`,
      );
      const authoredPaths = await Promise.all(
        [
          `${agentRoot}/sandbox/sandbox.ts`,
          `${agentRoot}/sandbox/workspace-helper.ts`,
          `${agentRoot}/sandbox/workspace-tools/helper.ts`,
          `${agentRoot}/workspace/helper.ts`,
        ].map((path) => write(path, `export async function helper() { "use step"; return 1; }`)),
      );

      await expect(discoverAuthoredWorkflowModules(appRoot)).resolves.toEqual({
        directiveModules: authoredPaths.sort(),
        workflowModules: [],
      });
    },
  );

  it("separates workflow modules from step-only modules and skips the rest", async () => {
    const tool = await write(
      "agent/tools/deploy.ts",
      `import { defineWorkflowTool } from "eve/tools";
import { plan } from "../lib/plan.ts";
export default defineWorkflowTool({
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
    await write(
      ".output.eve-backup-crashed/server/_libs/eve+zod.mjs",
      `const step = async function () { "use step"; };\nexport { step };`,
    );
    await write(
      ".eve/builds/x/output/server/index.mjs",
      `export async function f() { "use step"; }`,
    );
    await write(
      "src/components/banner.js",
      `// "use step" helpers live in ../lib\nexport function Banner() { return <b>hi</b>; }`,
    );
    await write(
      ".well-known/workflow/v1/flow.js",
      `export async function generated() {\n  "use workflow";\n}`,
    );
    await write("dist/out.js", `export async function f() { "use step"; }`);
    await write("agent/README.md", `"use workflow"`);

    await expect(discoverAuthoredWorkflowModules(appRoot)).resolves.toEqual({
      directiveModules: [helper, tool],
      workflowModules: [tool],
    });
  });

  it("leaves modules without a directive unparsed, so JSX in plain .js never fails the scan", async () => {
    await write(
      "src/app/layout.js",
      `export default function RootLayout({ children }) {
  return <html><body><code>defineWorkflowTool is only text here</code>{children}</body></html>;
}`,
    );
    const tool = await write(
      "agent/tools/deploy.ts",
      `import { defineWorkflowTool } from "eve/tools";
export default defineWorkflowTool({
  description: "d",
  async execute() {
    "use workflow";
    return 1;
  },
});`,
    );

    await expect(discoverAuthoredWorkflowModules(appRoot)).resolves.toEqual({
      directiveModules: [tool],
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

  it("discovers directives on the same line as their function declaration", async () => {
    const tool = await write(
      "agent/tools/inline.ts",
      `import { defineWorkflowTool } from "eve/tools";
export default defineWorkflowTool({ async execute() { "use workflow"; return plan(); } });`,
    );
    const helper = await write(
      "agent/lib/plan.ts",
      `export async function plan() { "use step"; return 1; }`,
    );
    await expect(discoverAuthoredWorkflowModules(appRoot)).resolves.toEqual({
      directiveModules: [helper, tool],
      workflowModules: [tool],
    });
  });

  it("reports an invalid directive placement as a build error", async () => {
    await write(
      "agent/tools/bad.ts",
      `export default {
  execute() {
    const inner = async () => {
      "use workflow";
    };
    return inner();
  },
};`,
    );

    await expect(discoverAuthoredWorkflowModules(appRoot)).rejects.toThrow(/use workflow/);
  });
});
