import { readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createApplicationBuildWorkspace,
  removeApplicationBuildWorkspace,
} from "#internal/application/build-workspace.js";
import { resolvePackageRoot } from "#internal/application/package.js";
import { useScenarioApp } from "#internal/testing/scenario-app.js";
import { WorkflowBundleBuilder } from "#internal/workflow-bundle/builder.js";
import { buildApplication } from "./build-application.js";
import { startProductionServer } from "./start-production-server.js";
import { prepareProductionApplicationHost } from "./prepare-application-host.js";

const ALIAS_MARKER = "workflow-alias-resolved";
const WORKFLOW_ASSET_MARKER = "workflow-raw-asset-embedded";
const STEP_ASSET_MARKER = "step-raw-asset-embedded";

/** The driver code the workflow build writes beside its entrypoint. */
function readWorkflowCode(buildDir: string): Promise<string> {
  return readFile(join(buildDir, "workflows.code.txt"), "utf8");
}

/** The production server's bundled modules, joined. */
async function readServerSources(outputDir: string): Promise<string> {
  const serverFiles = await readdir(join(outputDir, "server"), { recursive: true });
  const sources = await Promise.all(
    serverFiles
      .filter((file) => file.endsWith(".mjs"))
      .map((file) => readFile(join(outputDir, "server", file), "utf8")),
  );
  return sources.join("\n");
}

describe("authored workflow scope", () => {
  const scenarioApp = useScenarioApp();

  it.each(["tsconfig.json", "jsconfig.json"])(
    "resolves workflow aliases from the application's %s",
    async (configFile) => {
      const app = await scenarioApp({
        name: "workflow-app-alias",
        installDependencies: true,
        files: {
          [configFile]: JSON.stringify({
            compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } },
          }),
          "agent/agent.ts":
            'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });',
          "agent/instructions.md": "Call the probe tool.",
          "agent/tools/probe.ts":
            'import { defineWorkflowTool } from "eve/tools"; import { run } from "@/lib/run"; export default defineWorkflowTool({ description: "Probe", inputSchema: {}, execute: run });',
          "agent/channels/probe.ts": `import { defineChannel, GET } from "eve/channels";
import { start, getRun } from "eve/workflow/api";
import { run } from "@/lib/run";
export default defineChannel({ routes: [GET("/workflow-api", async () => {
  const started = await start(run);
  return Response.json(await getRun(started.runId).returnValue);
})] });`,
          "lib/run.ts": `import { createHook } from "eve/workflow";
import { describe } from "@/lib/describe";
import { deliver } from "./step";
export async function run() {
  "use workflow";
  using hook = createHook<string>({ token: "workflow-api-probe" });
  const returnedUndefined = await deliver();
  return { marker: describe(), returnedUndefined, payload: await hook };
}`,
          "lib/step.ts": `import { resumeHook } from "eve/workflow/api";
export async function deliver() {
  "use step";
  return (await resumeHook("workflow-api-probe", "approved")) === undefined;
}`,
          "lib/describe.ts": `export function describe() { return ${JSON.stringify(ALIAS_MARKER)}; }`,
        },
      });
      const appRoot = await realpath(app.appRoot);
      // One build: the server run below drives the aliased workflow, so the
      // driver code the output embeds already proves the aliases resolved.
      const outputDir = await buildApplication(appRoot, { skipSandboxPrewarm: false });
      const serverSource = await readServerSources(outputDir);
      expect(serverSource).toContain(ALIAS_MARKER);
      expect(serverSource).not.toContain('require("@/lib/describe")');
      const server = await startProductionServer(appRoot, { port: 0, host: "127.0.0.1" });
      try {
        expect((await fetch(new URL("/eve/v1/health", server.url))).status).toBe(200);
        const response = await fetch(new URL("/workflow-api", server.url), {
          signal: AbortSignal.timeout(30_000),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          marker: ALIAS_MARKER,
          returnedUndefined: true,
          payload: "approved",
        });
      } finally {
        await server.close();
      }
    },
  );

  it("excludes host workflows while retaining reachable workflow step helpers", async () => {
    const app = await scenarioApp({
      name: "workflow-agent-scope",
      installDependencies: true,
      files: {
        "agent/agent.ts":
          'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });',
        "agent/instructions.md": "Call the probe tool.",
        "agent/tools/probe.ts":
          'import { defineWorkflowTool } from "eve/tools"; import { run } from "../../lib/run"; export default defineWorkflowTool({ description: "Probe", inputSchema: {}, execute: run });',
        "lib/run.ts":
          'import { readMarker } from "./step"; export async function run() { "use workflow"; return readMarker(); }',
        "lib/step.ts":
          'import { hostname } from "node:os"; export async function readMarker() { "use step"; return hostname(); }',
        "components/layout.js":
          "export default function Layout() { return <div>Host application</div>; }",
        "workflows/host.ts":
          'import { readFileSync } from "node:fs"; export async function unrelatedHostWorkflow() { "use workflow"; return readFileSync("host.txt", "utf8"); }',
      },
    });
    const appRoot = await realpath(app.appRoot);
    const workspace = await createApplicationBuildWorkspace(appRoot);
    try {
      const host = await prepareProductionApplicationHost(workspace);
      const builder = new WorkflowBundleBuilder({
        agentName: host.compileResult.manifest.config.name,
        appRoot,
        compiledArtifactsBootstrapPath: host.compiledArtifacts.bootstrapPath,
        outDir: workspace.workflow.buildDir,
        rootDir: resolvePackageRoot(),
        authoredWorkflowModules: host.compiledArtifacts.authoredWorkflowModules,
      });
      await builder.build();
      const steps = await readFile(join(workspace.workflow.buildDir, "steps.mjs"), "utf8");
      const code = await readWorkflowCode(workspace.workflow.buildDir);
      expect(steps).toContain("lib/step.ts");
      expect(code).toContain("workflow//./lib/run//run");
      expect(code).toContain("step//./lib/step//readMarker");
      expect(code).not.toContain("unrelatedHostWorkflow");
      expect(steps).not.toContain("workflows/host.ts");
    } finally {
      await removeApplicationBuildWorkspace(workspace);
    }
  });

  // A workspace member without its own package.json shares the enclosing
  // package, so its workflow may import modules and assets from outside the app root.
  it.each([
    { layout: "a standalone app", member: "", toPackageRoot: "../.." },
    { layout: "a workspace member", member: "agents/probe/", toPackageRoot: "../../../.." },
  ])("embeds ?raw assets imported by workflow and step modules in $layout", async (input) => {
    const app = await scenarioApp({
      name: "workflow-raw-assets",
      installDependencies: true,
      files: {
        [`${input.member}agent/agent.ts`]:
          'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });',
        [`${input.member}agent/instructions.md`]: "Call the probe tool.",
        [`${input.member}agent/tools/probe.ts`]: `import { defineWorkflowTool } from "eve/tools"; import { run } from "${input.toPackageRoot}/lib/run"; export default defineWorkflowTool({ description: "Probe", inputSchema: {}, execute: run });`,
        "lib/run.ts":
          'import header from "../prompts/workflow.txt?raw"; import { readPrompt } from "./step"; export async function run() { "use workflow"; return header + (await readPrompt()); }',
        "lib/step.ts":
          'import prompt from "../prompts/step.md?raw"; export async function readPrompt() { "use step"; return prompt; }',
        "prompts/workflow.txt": WORKFLOW_ASSET_MARKER,
        "prompts/step.md": STEP_ASSET_MARKER,
      },
    });
    const appRoot = join(await realpath(app.appRoot), input.member);
    const outputDir = await buildApplication(appRoot, { skipSandboxPrewarm: false });
    const serverSource = await readServerSources(outputDir);
    expect(serverSource).toContain(STEP_ASSET_MARKER);
    // The host bundles the driver code as a plain string, so the marker appears in the output.
    expect(serverSource).toContain(WORKFLOW_ASSET_MARKER);
  });

  // The host and workflow bundles leave dependency imports to the host bundler,
  // but an authored import of an installed package's file is still authored.
  it("embeds ?raw assets from node_modules imported by workflow and step modules", async () => {
    const app = await scenarioApp({
      name: "workflow-dependency-raw-assets",
      installDependencies: true,
      dependencies: { "raw-assets": "file:./vendor/raw-assets" },
      files: {
        "agent/agent.ts":
          'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });',
        "agent/instructions.md": "Call the probe tool.",
        "agent/tools/probe.ts":
          'import { defineWorkflowTool } from "eve/tools"; import { run } from "../../lib/run"; export default defineWorkflowTool({ description: "Probe", inputSchema: {}, execute: run });',
        "lib/run.ts":
          'import header from "../node_modules/raw-assets/workflow.txt?raw"; import { readPrompt } from "./step"; export async function run() { "use workflow"; return header + (await readPrompt()); }',
        "lib/step.ts":
          'import prompt from "../node_modules/raw-assets/step.md?raw"; export async function readPrompt() { "use step"; return prompt; }',
        "vendor/raw-assets/package.json": JSON.stringify({ name: "raw-assets", version: "1.0.0" }),
        "vendor/raw-assets/workflow.txt": WORKFLOW_ASSET_MARKER,
        "vendor/raw-assets/step.md": STEP_ASSET_MARKER,
      },
    });
    const outputDir = await buildApplication(await realpath(app.appRoot), {
      skipSandboxPrewarm: false,
    });
    const serverSource = await readServerSources(outputDir);
    expect(serverSource).toContain(STEP_ASSET_MARKER);
    expect(serverSource).toContain(WORKFLOW_ASSET_MARKER);
  });
});
