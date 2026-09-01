import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prepareAuthoredWorkflowDirectives } from "./authored-workflow-directives.js";
import {
  discoverAuthoredWorkflowModules,
  readAuthoredExecuteWorkflowId,
} from "./authored-workflow-modules.js";

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
  return <html><body>{children}</body></html>;
}`,
    );
    const tool = await write(
      "agent/tools/deploy.ts",
      `export default {
  description: "d",
  async execute() {
    "use workflow";
    return 1;
  },
};`,
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

  it("rejects a directive that is not on its own line instead of compiling half of it", async () => {
    const source = `export default { description: "d", async execute() { "use workflow"; return 1; } };`;
    await write("agent/tools/inline.ts", source);

    // Discovery pre-scans by line, as the SDK does, and never sees this file;
    // the module transform parses it and must refuse rather than emit a stub
    // with no registered run behind it.
    await expect(discoverAuthoredWorkflowModules(appRoot)).resolves.toEqual({
      directiveModules: [],
      workflowModules: [],
    });
    await expect(
      prepareAuthoredWorkflowDirectives({
        filePath: join(appRoot, "agent/tools/inline.ts"),
        source,
      }),
    ).rejects.toThrow("is not on its own line");
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

describe("readAuthoredExecuteWorkflowId", () => {
  it("names the run a tool's execute compiles to, in both authoring shapes", async () => {
    const inline = await write(
      "agent/tools/deploy.ts",
      [
        'import { defineTool } from "eve/tools";',
        "export default defineTool({",
        '  description: "d",',
        "  inputSchema: {},",
        "  async execute() {",
        '    "use workflow";',
        "    return 1;",
        "  },",
        "});",
        "",
      ].join("\n"),
    );
    const referenced = await write(
      "agent/tools/nested/release.ts",
      [
        'import { defineTool } from "eve/tools";',
        'export default defineTool({ description: "d", inputSchema: {}, execute: release });',
        "async function release() {",
        '  "use workflow";',
        "  return 1;",
        "}",
        "",
      ].join("\n"),
    );
    const plain = await write(
      "agent/tools/ping.ts",
      'import { defineTool } from "eve/tools";\nexport default defineTool({ description: "d", inputSchema: {}, execute: () => 1 });\n',
    );

    await expect(readAuthoredExecuteWorkflowId({ appRoot, filePath: inline })).resolves.toBe(
      "workflow//./agent/tools/deploy//execute",
    );
    await expect(readAuthoredExecuteWorkflowId({ appRoot, filePath: referenced })).resolves.toBe(
      "workflow//./agent/tools/nested/release//release",
    );
    await expect(
      readAuthoredExecuteWorkflowId({ appRoot, filePath: plain }),
    ).resolves.toBeUndefined();
  });
});
