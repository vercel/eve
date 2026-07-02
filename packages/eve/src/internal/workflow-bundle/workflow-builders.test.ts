import { describe, expect, it } from "vitest";

import { resolvePackageRoot, resolvePackageSourceFilePath } from "#internal/application/package.js";

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
    // Stable workflow ids must match across deployments so
    // `start(ref, args, { deploymentId: "latest" })` lands on the
    // same registry key on a newer deployment. Step ids stay
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
