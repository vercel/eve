import { Output, type FlexibleSchema } from "ai";
import { HarnessAgent } from "#compiled/@ai-sdk/harness/agent/index.js";

import { loadHarnessAdapter } from "#execution/harness-agent/adapter.js";
import { createHarnessSandboxHandle } from "#execution/harness-agent/sandbox-session.js";
import type { HarnessAgentHarness, HarnessAgentSettings } from "#execution/harness-agent/types.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

export async function runHarnessAgent<TOutput = string>(input: {
  readonly abortSignal?: AbortSignal;
  readonly harness: HarnessAgentHarness;
  readonly model?: string;
  readonly outputSchema?: unknown;
  readonly sandbox: SandboxSession;
  readonly settings: HarnessAgentSettings;
  readonly task: string;
}): Promise<TOutput> {
  const sandboxHandle = await createHarnessSandboxHandle({
    harness: input.harness,
    sandbox: input.sandbox,
  });
  let session: Awaited<ReturnType<HarnessAgent["createSession"]>> | undefined;
  let output: TOutput;

  try {
    const harness = await loadHarnessAdapter({
      bridge: sandboxHandle.bridge,
      harness: input.harness,
      model: input.model,
    });
    const agent = new HarnessAgent({
      harness,
      id: input.settings.id,
      instructions: input.settings.instructions,
      output:
        input.outputSchema === undefined
          ? undefined
          : Output.object({ schema: input.outputSchema as FlexibleSchema<unknown> }),
      permissionMode: "allow-all",
      sandboxConfig: { workDir: resolveHarnessWorkDir(input.settings.workingDirectory) },
      skills: input.settings.skills,
    });
    session = await agent.createSession({
      abortSignal: input.abortSignal,
      sandboxSession: sandboxHandle.session,
    });
    const result = await agent.generate({
      abortSignal: input.abortSignal,
      prompt: input.task,
      session,
    });
    output = (input.outputSchema === undefined ? result.text : result.output) as TOutput;
  } catch (error) {
    await cleanupHarnessInvocation({ dispose: sandboxHandle.dispose, session });
    throw error;
  }

  const failures = await cleanupHarnessInvocation({ dispose: sandboxHandle.dispose, session });
  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to clean up the HarnessAgent invocation.");
  }
  return output;
}

async function cleanupHarnessInvocation(input: {
  readonly dispose: () => Promise<void>;
  readonly session: Awaited<ReturnType<HarnessAgent["createSession"]>> | undefined;
}): Promise<unknown[]> {
  const cleanup = await Promise.allSettled([input.session?.destroy(), input.dispose()]);
  return cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}

function resolveHarnessWorkDir(workingDirectory: string | undefined): string {
  if (workingDirectory === undefined || workingDirectory === ".") {
    return "workspace";
  }
  if (
    workingDirectory.startsWith("/") ||
    workingDirectory.split("/").some((segment) => segment === "..")
  ) {
    throw new Error("HarnessAgent workingDirectory must stay within the eve workspace.");
  }
  return `workspace/${workingDirectory.replace(/^\.\//, "")}`;
}
