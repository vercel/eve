import type { AlsContext } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import { resolveSandboxAccessInput } from "#context/providers/sandbox.js";
import type { EnsureSandboxAccessInput } from "#execution/sandbox/ensure.js";
import type { HarnessSession } from "#harness/types.js";

export type WorkflowSandboxReferenceData = Pick<
  EnsureSandboxAccessInput,
  "compiledArtifactsSource" | "nodeId" | "sessionId" | "state"
>;

export async function captureWorkflowSandboxReference(input: {
  readonly ctx: AlsContext;
  readonly session: HarnessSession;
}): Promise<WorkflowSandboxReferenceData> {
  const resolved = resolveSandboxAccessInput(input.ctx, input.session);
  if (resolved === undefined) throw new Error("The session has no sandbox runtime bundle.");
  const access = input.ctx.require(SandboxKey);
  await access.get();
  const { compiledArtifactsSource, nodeId, sessionId } = resolved;
  return { compiledArtifactsSource, nodeId, sessionId, state: await access.captureState() };
}
