import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  resolveInstalledPackageInfo,
  resolvePackageRoot,
  resolvePackageSourceFilePath,
} from "#internal/application/package.js";

import { applyWorkflowTransform } from "./workflow-builders.js";
import { transformWorkflowDirectives } from "./workflow-transformer.js";

describe("applyWorkflowTransform", () => {
  it("keeps eve workflow references stable when eve is the project root", async () => {
    const filename = "src/execution/turn-workflow.ts";
    const transformed = await applyWorkflowTransform(
      filename,
      ["export async function turnWorkflow(): Promise<void> {", '  "use workflow";', "}", ""].join(
        "\n",
      ),
      "workflow",
      resolvePackageSourceFilePath(filename),
      resolvePackageRoot(),
    );

    expect(transformed.workflowManifest.workflows?.[filename]?.turnWorkflow).toEqual({
      workflowId: "workflow//eve//turnWorkflow",
    });
  });

  it("keeps the shared subagent tool workflow stable", async () => {
    const filename = "src/runtime/subagents/workflow.ts";
    const transformed = await applyWorkflowTransform(
      filename,
      [
        "export async function subagentToolExecuteWorkflow(): Promise<void> {",
        '  "use workflow";',
        "}",
        "",
      ].join("\n"),
      "workflow",
      resolvePackageSourceFilePath(filename),
      resolvePackageRoot(),
    );

    expect(transformed.workflowManifest.workflows?.[filename]?.subagentToolExecuteWorkflow).toEqual(
      {
        workflowId: "workflow//eve//subagentToolExecuteWorkflow",
      },
    );
    expect(transformed.code).toContain(
      'globalThis.__private_workflows.set("workflow//eve//subagentToolExecuteWorkflow", subagentToolExecuteWorkflow);',
    );
  });

  it("stamps versioned package workflow metadata without consuming the framework body", async () => {
    const filename = "src/execution/tools/sleep.ts";
    const transformed = await applyWorkflowTransform(
      filename,
      [
        "export async function executeSleepTool(): Promise<string> {",
        '  "use workflow";',
        '  return "done";',
        "}",
        "",
      ].join("\n"),
      "metadata",
      resolvePackageSourceFilePath(filename),
      resolvePackageRoot(),
    );

    expect(transformed.code).toContain('"use workflow";');
    expect(transformed.code).toContain('return "done";');
    const packageInfo = resolveInstalledPackageInfo();
    expect(transformed.code).toContain(
      `executeSleepTool.workflowId = "workflow//${packageInfo.name}@${packageInfo.version}//executeSleepTool";`,
    );
    expect(transformed.code).not.toContain("__private_workflows.set");
  });

  it("registers step functions in step mode", async () => {
    const transformed = await applyWorkflowTransform(
      "steps/ping.ts",
      [
        "export async function ping(input: { value: string }): Promise<string> {",
        '  "use step";',
        "  return input.value;",
        "}",
        "",
      ].join("\n"),
      "step",
    );

    expect(transformed.workflowManifest).toEqual({
      steps: {
        "steps/ping.ts": {
          ping: {
            stepId: "step//./steps/ping//ping",
          },
        },
      },
    });
    expect(transformed.code).toContain(
      'import { registerStepFunction } from "workflow/internal/private";',
    );
    expect(transformed.code).toContain('registerStepFunction("step//./steps/ping//ping", ping);');
    expect(transformed.code).not.toContain('"use step"');
  });

  it("replaces step functions with workflow proxies in workflow mode", async () => {
    const transformed = await applyWorkflowTransform(
      "src/execution/task.ts",
      [
        'import { randomUUID } from "node:crypto";',
        'export const TASK_KIND = "task";',
        "export const RETRY_OFFSET = -1;",
        "",
        "export async function localStep(value: string): Promise<{ value: string }> {",
        '  "use step";',
        "  return { value: `${value}:${randomUUID()}` };",
        "}",
        "",
      ].join("\n"),
      "workflow",
      undefined,
      undefined,
    );

    expect(transformed.code).toContain(
      'export var localStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./src/execution/task//localStep");',
    );
    expect(transformed.code).toContain('export const TASK_KIND = "task";');
    expect(transformed.code).toContain("export const RETRY_OFFSET = -1;");
    expect(transformed.code).not.toContain("node:crypto");
    expect(transformed.code).not.toContain("randomUUID");
  });

  it("registers workflow functions in workflow mode", async () => {
    const transformed = await applyWorkflowTransform(
      "src/execution/workflow-entry.ts",
      [
        "export async function workflowEntry(input: { id: string }): Promise<string> {",
        '  "use workflow";',
        "  return input.id;",
        "}",
        "",
      ].join("\n"),
      "workflow",
      undefined,
      undefined,
    );

    expect(transformed.workflowManifest).toEqual({
      workflows: {
        "src/execution/workflow-entry.ts": {
          workflowEntry: {
            workflowId: "workflow//eve//workflowEntry",
          },
        },
      },
    });
    expect(transformed.code).toContain(
      'workflowEntry.workflowId = "workflow//eve//workflowEntry";',
    );
    expect(transformed.code).toContain(
      'globalThis.__private_workflows.set("workflow//eve//workflowEntry", workflowEntry);',
    );
  });

  it("does not attach a later step directive to an earlier async function", async () => {
    const transformed = await applyWorkflowTransform(
      "src/execution/workflow-entry.ts",
      [
        "export async function workflowEntry(input: { value: string }): Promise<string> {",
        '  "use workflow";',
        "  return await runWorkflowLoop(input);",
        "}",
        "",
        "async function runWorkflowLoop(input: { value: string }): Promise<string> {",
        "  return input.value;",
        "}",
        "",
        "async function notifyDelegatedParentStep(input: { value: string }): Promise<{ value: string }> {",
        '  "use step";',
        "  return input;",
        "}",
        "",
      ].join("\n"),
      "workflow",
      undefined,
      undefined,
    );

    expect(transformed.workflowManifest).toEqual({
      steps: {
        "src/execution/workflow-entry.ts": {
          notifyDelegatedParentStep: {
            stepId: "step//./src/execution/workflow-entry//notifyDelegatedParentStep",
          },
        },
      },
      workflows: {
        "src/execution/workflow-entry.ts": {
          workflowEntry: {
            workflowId: "workflow//eve//workflowEntry",
          },
        },
      },
    });
    expect(transformed.code).toContain("async function runWorkflowLoop");
    expect(transformed.code).toContain(
      'var notifyDelegatedParentStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./src/execution/workflow-entry//notifyDelegatedParentStep");',
    );
    expect(transformed.code).not.toContain("step//./src/execution/workflow-entry//runWorkflowLoop");
  });

  it("strips the @<version> stamp for stable workflow names but not for steps", async () => {
    // Stable workflow ids must match across deployments so an explicit
    // deployment target lands on the same registry key. Step ids stay
    // version-stamped because they are per-deployment internal
    // identifiers, not cross-deployment routing keys.
    const transformed = await transformWorkflowDirectives({
      filename: "src/execution/turn-workflow.ts",
      mode: "workflow",
      moduleSpecifier: "eve@1.2.3",
      source: [
        "export async function turnWorkflow(input: { id: string }): Promise<string> {",
        '  "use workflow";',
        "  return input.id;",
        "}",
        "",
        "export async function notifyDriverStep(input: { id: string }): Promise<void> {",
        '  "use step";',
        "  return;",
        "}",
        "",
      ].join("\n"),
      stableModuleSpecifier: "eve",
      stableWorkflowNames: new Set(["turnWorkflow"]),
    });

    expect(transformed.workflowManifest).toEqual({
      steps: {
        "src/execution/turn-workflow.ts": {
          notifyDriverStep: {
            stepId: "step//eve@1.2.3//notifyDriverStep",
          },
        },
      },
      workflows: {
        "src/execution/turn-workflow.ts": {
          turnWorkflow: {
            workflowId: "workflow//eve//turnWorkflow",
          },
        },
      },
    });
    expect(transformed.code).toContain('turnWorkflow.workflowId = "workflow//eve//turnWorkflow";');
    expect(transformed.code).toContain(
      'globalThis.__private_workflows.set("workflow//eve//turnWorkflow", turnWorkflow);',
    );
  });
});

describe("applyWorkflowTransform for authored application modules", () => {
  const appRoot = "/app";
  const toolPath = "/app/agent/tools/deploy.ts";
  const toolSource = [
    'import { readFile } from "node:fs/promises";',
    'import { defineTool } from "eve/tools";',
    'import { ask } from "eve/workflow";',
    'import { sleep } from "workflow";',
    'import { z } from "zod";',
    "",
    'const APPROVE = [{ id: "approve", label: "Deploy" }];',
    "",
    "export default defineTool({",
    '  description: "Deploy",',
    "  inputSchema: z.object({ service: z.string() }),",
    "  async execute({ service }: { service: string }, ctx: ToolContext) {",
    '    "use workflow";',
    "    const plan = await planDeploy(service);",
    "    const answer = await (await ask(ctx, { prompt: plan, options: APPROVE }));",
    '    await sleep("1s");',
    '    return { deployed: answer.optionId === "approve" };',
    "  },",
    "});",
    "",
    "async function planDeploy(service: string): Promise<string> {",
    '  "use step";',
    '  return await readFile(`/plans/${service}`, "utf8");',
    "}",
    "",
  ].join("\n");

  it("mints application-relative ids and keeps the module body in workflow mode", async () => {
    const transformed = await applyWorkflowTransform(
      "agent/tools/deploy.ts",
      toolSource,
      "workflow",
      toolPath,
      appRoot,
    );

    expect(transformed.workflowManifest).toEqual({
      steps: {
        "agent/tools/deploy.ts": {
          planDeploy: { stepId: "step//./agent/tools/deploy//planDeploy" },
        },
      },
      workflows: {
        "agent/tools/deploy.ts": {
          execute: { workflowId: "workflow//./agent/tools/deploy//execute" },
        },
      },
    });
    expect(transformed.code).toContain(
      'var planDeploy = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./agent/tools/deploy//planDeploy");',
    );
    expect(transformed.code).toContain(
      'globalThis.__private_workflows.set("workflow//./agent/tools/deploy//execute", execute);',
    );
    expect(transformed.code).toContain("async function execute({ service }");
    expect(transformed.code).toContain("const APPROVE = ");
    expect(transformed.code).toContain('import { sleep } from "workflow";');
    expect(transformed.code).not.toContain("export default");
    expect(transformed.code).not.toContain("defineTool");
    expect(transformed.code).not.toContain("zod");
    expect(transformed.code).not.toContain("node:fs/promises");
    expect(transformed.code).not.toContain('"use workflow"');
  });

  it("registers steps and stubs the workflow body in step mode", async () => {
    const transformed = await applyWorkflowTransform(
      "agent/tools/deploy.ts",
      toolSource,
      "step",
      toolPath,
      appRoot,
    );

    expect(transformed.code).toContain(
      'registerStepFunction("step//./agent/tools/deploy//planDeploy", planDeploy);',
    );
    expect(transformed.code).toContain(
      'execute.workflowId = "workflow//./agent/tools/deploy//execute";',
    );
    expect(transformed.code).toContain(
      "You attempted to execute workflow execute function directly",
    );
    expect(transformed.code).toContain("export default defineTool({");
    expect(transformed.code).toContain("  execute,\n");
    expect(transformed.code).toContain('import { z } from "zod";');
  });

  it("stamps ids without registering in client mode", async () => {
    const transformed = await applyWorkflowTransform(
      "agent/tools/deploy.ts",
      toolSource,
      "client",
      toolPath,
      appRoot,
    );

    expect(transformed.code).toContain(
      'planDeploy.stepId = "step//./agent/tools/deploy//planDeploy";',
    );
    expect(transformed.code).not.toContain("registerStepFunction");
    expect(transformed.code).toContain(
      'execute.workflowId = "workflow//./agent/tools/deploy//execute";',
    );
  });

  it("leaves authored modules without directives untouched", async () => {
    const source = 'export const helper = () => "use step";\n';
    const transformed = await applyWorkflowTransform(
      "agent/lib/helper.ts",
      source,
      "workflow",
      "/app/agent/lib/helper.ts",
      appRoot,
    );

    expect(transformed).toEqual({ code: source, workflowManifest: {} });
  });

  it("keeps non-step exports of an authored step module in workflow mode", async () => {
    const transformed = await applyWorkflowTransform(
      "agent/lib/steps.ts",
      [
        'import { createHash } from "node:crypto";',
        "",
        "export function formatPlan(plan: string): string {",
        "  return `plan: ${plan}`;",
        "}",
        "",
        "export async function hashPlan(plan: string): Promise<string> {",
        '  "use step";',
        '  return createHash("sha256").update(plan).digest("hex");',
        "}",
        "",
      ].join("\n"),
      "workflow",
      "/app/agent/lib/steps.ts",
      appRoot,
    );

    expect(transformed.code).toContain("export function formatPlan(plan: string): string {");
    expect(transformed.code).toContain(
      'export var hashPlan = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./agent/lib/steps//hashPlan");',
    );
    expect(transformed.code).not.toContain("node:crypto");
  });

  it("treats eve package sources as framework modules even under the project root", async () => {
    const eveRoot = resolvePackageRoot();
    const filename = "src/execution/turn-workflow.ts";
    const transformed = await applyWorkflowTransform(
      filename,
      ["export async function turnWorkflow(): Promise<void> {", '  "use workflow";', "}", ""].join(
        "\n",
      ),
      "workflow",
      resolvePackageSourceFilePath(filename),
      eveRoot,
    );

    expect(transformed.workflowManifest.workflows?.[filename]?.turnWorkflow?.workflowId).toBe(
      "workflow//eve//turnWorkflow",
    );
  });

  it("keeps the session command inbox factory visible in workflow driver builds", async () => {
    const eveRoot = resolvePackageRoot();
    const filename = "src/execution/session-command-inbox.ts";
    const source = readFileSync(resolvePackageSourceFilePath(filename), "utf8");
    const transformed = await applyWorkflowTransform(
      filename,
      source,
      "workflow",
      resolvePackageSourceFilePath(filename),
      eveRoot,
    );

    expect(transformed.code).toContain("export function createSessionCommandInbox");
    expect(transformed.code).not.toContain("subagent");
    expect(transformed.code).not.toContain("WORKFLOW_USE_STEP");
  });
});
