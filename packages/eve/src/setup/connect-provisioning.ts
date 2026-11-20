import type { ProcessOutputHandler } from "#setup/primitives/process-output.js";
import { runVercel, type RunVercelOptions } from "#setup/primitives/run-vercel.js";

export const CONNECT_MUTATION_TIMEOUT_MS = 2 * 60_000;

export type ConnectTriggerAttachmentResult =
  | { state: "attached" }
  | { state: "detach-failed" }
  | { state: "attach-failed" };

interface ReplaceConnectTriggerOptions {
  connectorUid: string;
  projectRoot: string;
  triggerPath: string;
  onOutput: ProcessOutputHandler;
  projectId?: string;
  orgId?: string;
  environment?: string;
  signal?: AbortSignal;
  deps?: { runVercel: (args: string[], options: RunVercelOptions) => Promise<boolean> };
}

export async function replaceConnectTrigger(
  options: ReplaceConnectTriggerOptions,
): Promise<ConnectTriggerAttachmentResult> {
  const run = options.deps?.runVercel ?? runVercel;
  const detachArgs = ["connect", "detach", options.connectorUid];
  if (options.projectId !== undefined) detachArgs.push("--project", options.projectId);
  detachArgs.push("--yes");
  if (options.orgId !== undefined) detachArgs.push("--scope", options.orgId);
  const detached = await run(detachArgs, {
    cwd: options.projectRoot,
    onOutput: options.onOutput,
    nonInteractive: true,
    timeoutMs: CONNECT_MUTATION_TIMEOUT_MS,
    signal: options.signal,
  });
  if (!detached) return { state: "detach-failed" };

  const attachArgs = ["connect", "attach", options.connectorUid];
  if (options.projectId !== undefined) attachArgs.push("--project", options.projectId);
  if (options.environment !== undefined) attachArgs.push("--environment", options.environment);
  attachArgs.push("--triggers", "--trigger-path", options.triggerPath, "--yes");
  if (options.orgId !== undefined) attachArgs.push("--scope", options.orgId);
  const attached = await run(attachArgs, {
    cwd: options.projectRoot,
    onOutput: options.onOutput,
    nonInteractive: true,
    timeoutMs: CONNECT_MUTATION_TIMEOUT_MS,
    signal: options.signal,
  });
  return attached ? { state: "attached" } : { state: "attach-failed" };
}
