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
import { buildApplication } from "./build-application.js";
import { startProductionServer } from "./start-production-server.js";
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
        await buildApplication(appRoot, { skipVercelSandboxPrewarm: false });
        const server = await startProductionServer(appRoot, { port: 0, host: "127.0.0.1" });
        try {
          expect((await fetch(new URL("/eve/v1/health", server.url))).status).toBe(200);
        } finally {
          await server.close();
        }
      } finally {
        await removeApplicationBuildWorkspace(workspace);
      }
    },
  );

  it("excludes route-owned host workflows while retaining reachable eve workflow helpers", async () => {
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
        "app/api/evidence-review/route.ts":
          'import { start } from "workflow/api"; import { requestEvidenceReviewWorkflow } from "../../../workflows/evidence-review"; export async function POST() { const run = await start(requestEvidenceReviewWorkflow, []); return Response.json({ runId: run.runId }); }',
        "components/layout.js":
          "export default function Layout() { return <div>Host application</div>; }",
        "workflows/evidence-review.ts":
          'import { checkpoint, persistCheckpoint } from "./mixed-runtime"; export async function requestEvidenceReviewWorkflow() { "use workflow"; const value = checkpoint("review"); await persistCheckpoint(value); return value; }',
        "workflows/mixed-runtime.ts":
          'import { randomUUID } from "node:crypto"; export function checkpoint(reviewId: string) { return { reviewId }; } export async function persistCheckpoint(value: { reviewId: string }) { "use step"; return { ...value, checkpointId: randomUUID() }; }',
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
      expect(code).not.toContain("requestEvidenceReviewWorkflow");
      expect(code).not.toContain("persistCheckpoint");
      expect(steps).not.toContain("workflows/evidence-review.ts");
      expect(steps).not.toContain("workflows/mixed-runtime.ts");
    } finally {
      await removeApplicationBuildWorkspace(workspace);
    }
  });
});
