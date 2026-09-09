import { HarnessAgent, type HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import { type FlexibleSchema, Output } from "ai";
import type { SandboxSession } from "eve/sandbox";

import { adaptHarnessNetworkSandboxSession } from "./sandbox-session";
import type {
  CreateHarnessAgentToolSettings,
  HarnessBridgeSettings,
  HarnessAgentToolOutput,
  OptionalOutputSchema,
} from "./types";

type RunHarnessAgentSettings<TOutputSchema extends OptionalOutputSchema = undefined> = Omit<
  CreateHarnessAgentToolSettings<TOutputSchema>,
  "description"
> & {
  readonly abortSignal?: AbortSignal;
  readonly harness: (settings: HarnessBridgeSettings) => HarnessAgentAdapter;
  readonly sandbox: SandboxSession;
  readonly task: string;
};

export async function runHarnessAgent<TOutputSchema extends OptionalOutputSchema = undefined>(
  input: RunHarnessAgentSettings<TOutputSchema>,
): Promise<HarnessAgentToolOutput<TOutputSchema>> {
  const sandboxSession = await adaptHarnessNetworkSandboxSession({
    sandbox: input.sandbox,
  });
  let session: Awaited<ReturnType<HarnessAgent["createSession"]>> | undefined;
  let resultOutput: HarnessAgentToolOutput<TOutputSchema>;

  try {
    const port = sandboxSession.ports[0];
    if (port === undefined) {
      throw new Error("The adapted HarnessAgent sandbox has no leased port.");
    }
    const portEndpoint = await sandboxSession.getPortEndpoint({
      port,
      protocol: "ws",
    });
    const agent = new HarnessAgent({
      harness: input.harness({ port, portEndpoint }),
      id: input.id,
      instructions: input.instructions,
      model: input.model,
      output:
        input.outputSchema === undefined
          ? undefined
          : Output.object({
              schema: input.outputSchema as FlexibleSchema<HarnessAgentToolOutput<TOutputSchema>>,
            }),
      permissionMode: "allow-all",
      ...(input.workDir === undefined ? {} : { sandboxConfig: { workDir: input.workDir } }),
      skills: input.skills,
    });
    session = await agent.createSession({
      abortSignal: input.abortSignal,
      sandboxSession,
    });
    const result = await agent.generate({
      abortSignal: input.abortSignal,
      prompt: input.task,
      session,
    });
    resultOutput = (
      input.outputSchema === undefined ? result.text : result.output
    ) as HarnessAgentToolOutput<TOutputSchema>;
  } catch (error) {
    const failures = await cleanupHarnessInvocation({
      dispose: sandboxSession.destroy,
      session,
    });
    if (failures.length > 0) {
      throw new AggregateError(
        [error, ...failures],
        "The HarnessAgent invocation failed and could not be fully cleaned up.",
        { cause: error },
      );
    }
    throw error;
  }

  const failures = await cleanupHarnessInvocation({
    dispose: sandboxSession.destroy,
    session,
  });
  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to clean up the HarnessAgent invocation.");
  }
  return resultOutput;
}

async function cleanupHarnessInvocation(input: {
  readonly dispose: () => PromiseLike<void>;
  readonly session: Awaited<ReturnType<HarnessAgent["createSession"]>> | undefined;
}): Promise<unknown[]> {
  const failures: unknown[] = [];
  try {
    await input.session?.destroy();
  } catch (error) {
    failures.push(error);
  }
  try {
    await input.dispose();
  } catch (error) {
    failures.push(error);
  }
  return failures;
}
