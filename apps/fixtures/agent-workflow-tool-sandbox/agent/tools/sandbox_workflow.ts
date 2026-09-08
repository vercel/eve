import { defineWorkflowTool, type WorkflowToolContext } from "eve/tools";
import { z } from "zod";

interface SandboxWorkflowResult {
  readonly marker: string;
  readonly observed: string;
  readonly persisted: boolean;
}

export default defineWorkflowTool({
  description:
    "Writes a random marker in the session sandbox, then verifies it from a later workflow step.",
  async execute(
    _input: Record<string, never>,
    ctx: WorkflowToolContext,
  ): Promise<SandboxWorkflowResult> {
    "use workflow";

    const marker = await writeMarker(ctx);
    return await inspectMarker(ctx, marker);
  },
  inputSchema: z.object({}),
  sandbox: true,
});

async function writeMarker(ctx: WorkflowToolContext): Promise<string> {
  "use step";

  const marker = `WORKFLOW-SANDBOX-${crypto.randomUUID()}`;
  const sandbox = await ctx.getSandbox();
  await sandbox.writeTextFile({
    content: marker,
    path: "workflow-sandbox-marker.txt",
  });
  return marker;
}

async function inspectMarker(
  ctx: WorkflowToolContext,
  marker: string,
): Promise<SandboxWorkflowResult> {
  "use step";

  const sandbox = await ctx.getSandbox();
  const result = await sandbox.run({
    command: "cat /workspace/workflow-sandbox-marker.txt",
  });
  const observed = result.stdout.trim();
  return { marker, observed, persisted: observed === marker };
}
