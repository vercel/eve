import type { WorkflowStepToolContext, WorkflowToolContext } from "eve/tools";
import { sleep } from "workflow";

export async function probeSandbox({ service }: { service: string }, ctx: WorkflowToolContext) {
  "use workflow";
  const before = await writeMarker(ctx, service);
  await sleep("10ms");
  return await readMarker(ctx, before);
}

async function writeMarker(ctx: WorkflowStepToolContext, service: string) {
  "use step";
  const sandbox = await ctx.getSandbox();
  const path = `workflow-${ctx.callId}.txt`;
  await sandbox.writeTextFile({ path, content: `workflow-sandbox:${service}` });
  return { id: sandbox.id, path };
}

async function readMarker(ctx: WorkflowStepToolContext, before: { id: string; path: string }) {
  "use step";
  const sandbox = await ctx.getSandbox();
  const content = await sandbox.readTextFile({ path: before.path });
  const command = await sandbox.run({ command: "test -d /workspace" });
  return { content, sameSandbox: sandbox.id === before.id, commandExitCode: command.exitCode };
}
