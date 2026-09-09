import { HarnessAgent, type HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import { type FlexibleSchema, Output, type ToolSet } from "ai";

import { adaptHarnessNetworkSandboxSession } from "./sandbox-session";
import type { HarnessAgentToolOutput, OptionalOutputSchema, RunHarnessAgentArgs } from "./types";

export async function runHarnessAgent<
  THarness extends HarnessAgentAdapter<any> = HarnessAgentAdapter,
  TUserTools extends ToolSet = {},
  RuntimeContext extends Record<string, unknown> = Record<string, unknown>,
  TOutputSchema extends OptionalOutputSchema = undefined,
  CallOptions = never,
>(
  args: RunHarnessAgentArgs<THarness, TUserTools, RuntimeContext, TOutputSchema, CallOptions>,
): Promise<HarnessAgentToolOutput<TOutputSchema>> {
  const sandboxSession = await adaptHarnessNetworkSandboxSession({
    sandbox: await args.ctx.getSandbox(),
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
    const { harness, outputSchema, sandboxConfig, ...settings } = args.settings;
    const workDir = args.input.workDir ?? sandboxConfig?.workDir;
    const agent = new HarnessAgent({
      ...settings,
      harness: harness({ port, portEndpoint }),
      output:
        outputSchema === undefined
          ? undefined
          : Output.object({
              schema: outputSchema as FlexibleSchema<HarnessAgentToolOutput<TOutputSchema>>,
            }),
      ...(sandboxConfig === undefined && workDir === undefined
        ? {}
        : {
            sandboxConfig: {
              ...sandboxConfig,
              ...(workDir === undefined ? {} : { workDir }),
            },
          }),
    });
    session = await agent.createSession({
      abortSignal: args.ctx.abortSignal,
      sandboxSession,
    });
    const result = await agent.generate({
      abortSignal: args.ctx.abortSignal,
      prompt: args.input.task,
      session,
    });
    resultOutput = (
      outputSchema === undefined ? result.text : result.output
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
