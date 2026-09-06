import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createApplicationBuildWorkspace,
  removeApplicationBuildWorkspace,
} from "#internal/application/build-workspace.js";
import { resolvePackageRoot } from "#internal/application/package.js";
import { useScenarioApp } from "#internal/testing/scenario-app.js";
import { WorkflowBundleBuilder } from "#internal/workflow-bundle/builder.js";
import { prepareProductionApplicationHost } from "./prepare-application-host.js";

const ALIAS_MARKER = "workflow-alias-resolved";

function workflowCode(source: string): string {
  const match = source.match(
    /Buffer\.from\((\[[\s\S]*?\])\.join\(""\), "base64"\)\.toString\("utf8"\)/,
  );
  return Buffer.from((JSON.parse(match?.[1] ?? "[]") as string[]).join(""), "base64").toString(
    "utf8",
  );
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
          "agent/agent.ts": 'export default { model: "openai/gpt-5.4" };',
          "agent/instructions.md": "Call the probe tool.",
          "agent/tools/probe.ts":
            'import { defineWorkflowTool } from "eve/tools"; import { describe } from "@/lib/describe"; export default defineWorkflowTool({ description: "Probe", inputSchema: {}, async execute() { "use workflow"; return describe(); } });',
          "lib/describe.ts": `export function describe() { return ${JSON.stringify(ALIAS_MARKER)}; }`,
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
          watch: false,
          authoredWorkflowModules: host.compiledArtifacts.authoredWorkflowModules,
        });
        await builder.build();
        const code = workflowCode(
          await readFile(join(workspace.workflow.buildDir, "workflows.mjs"), "utf8"),
        );
        expect(code).toContain(ALIAS_MARKER);
        expect(code).not.toContain('require("@/lib/describe")');
      } finally {
        await removeApplicationBuildWorkspace(workspace);
      }
    },
  );

  it("excludes host workflows while retaining reachable workflow step helpers", async () => {
    const app = await scenarioApp({
      name: "workflow-agent-scope",
      installDependencies: true,
      files: {
        "agent/agent.ts": 'export default { model: "openai/gpt-5.4" };',
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
        watch: false,
        authoredWorkflowModules: host.compiledArtifacts.authoredWorkflowModules,
      });
      await builder.build();
      const steps = await readFile(join(workspace.workflow.buildDir, "steps.mjs"), "utf8");
      const code = workflowCode(
        await readFile(join(workspace.workflow.buildDir, "workflows.mjs"), "utf8"),
      );
      expect(steps).toContain("lib/step.ts");
      expect(code).toContain("workflow//./lib/run//run");
      expect(code).toContain("step//./lib/step//readMarker");
      expect(code).not.toContain("unrelatedHostWorkflow");
      expect(steps).not.toContain("workflows/host.ts");
    } finally {
      await removeApplicationBuildWorkspace(workspace);
    }
  });
});
