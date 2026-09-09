import {
  HarnessAgent,
  type HarnessAgentAdapter,
  type HarnessAgentSession,
} from "@ai-sdk/harness/agent";
import type {
  HarnessWorkflowAgent,
  HarnessWorkflowState,
  HarnessWorkflowStreamResult,
} from "@ai-sdk/workflow-harness";
import { runHarnessAgentStep as runWorkflowHarnessAgentStep } from "@ai-sdk/workflow-harness";
import type { FlexibleSchema, ToolSet } from "ai";
import { isStepCount, Output } from "ai";

import { adaptHarnessNetworkSandboxSession } from "./sandbox-session";
import type {
  HarnessAgentToolOutput,
  OptionalOutputSchema,
  RunHarnessAgentStepArgs,
} from "./types";

type HarnessAgentWorkflowStepResult<TOutput> =
  | { readonly state: HarnessWorkflowState }
  | { readonly output: TOutput; readonly state: HarnessWorkflowState };

type HarnessAgentTerminalResult = HarnessWorkflowStreamResult & {
  readonly output: PromiseLike<unknown>;
  readonly text: PromiseLike<string>;
};

export async function runHarnessAgentStep<
  THarness extends HarnessAgentAdapter<any> = HarnessAgentAdapter,
  TUserTools extends ToolSet = {},
  RuntimeContext extends Record<string, unknown> = Record<string, unknown>,
  TOutputSchema extends OptionalOutputSchema = undefined,
  CallOptions = never,
>(
  args: RunHarnessAgentStepArgs<THarness, TUserTools, RuntimeContext, TOutputSchema, CallOptions>,
): Promise<HarnessAgentWorkflowStepResult<HarnessAgentToolOutput<TOutputSchema>>> {
  const sandboxSession = await adaptHarnessNetworkSandboxSession({
    leaseId: args.state.sessionId,
    sandbox: await args.ctx.getSandbox(),
  });
  let activeSession: HarnessAgentSession | undefined;
  let terminalResult: HarnessAgentTerminalResult | undefined;
  let nextState: HarnessWorkflowState | undefined;

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
      stopWhen: isStepCount(1),
    });
    const workflowAgent: HarnessWorkflowAgent = {
      async createSession(sessionOptions) {
        activeSession = await agent.createSession({
          ...sessionOptions,
          abortSignal: args.ctx.abortSignal,
          sandboxSession,
        });
        return activeSession;
      },
      async continueStream(streamOptions) {
        const result = await agent.continueStream({
          ...streamOptions,
          abortSignal: args.ctx.abortSignal,
        });
        terminalResult = result;
        return result;
      },
      async stream(streamOptions) {
        const result = await agent.stream({
          ...streamOptions,
          abortSignal: args.ctx.abortSignal,
        });
        terminalResult = result;
        return result;
      },
    };

    nextState = await runWorkflowHarnessAgentStep({
      agent: workflowAgent,
      destroyOnFinish: true,
      state: args.state,
      writable: new WritableStream(),
    });

    if (nextState.status === "awaiting_tool_approval") {
      if (nextState.continueFrom === undefined) {
        throw new Error(
          "The HarnessAgent workflow requested tool approval without continuation state.",
        );
      }
      const session = await agent.createSession({
        abortSignal: args.ctx.abortSignal,
        continueFrom: nextState.continueFrom,
        sandboxSession,
        sessionId: nextState.sessionId,
      });
      await session.destroy();
      throw new Error("HarnessAgent workflow tools do not support tool approval continuations.");
    }
    if (nextState.status === "failed" || nextState.status === "ready_for_next_step") {
      return { state: nextState };
    }
    if (nextState.status !== "finished") {
      throw new Error(`The HarnessAgent workflow reached unexpected status "${nextState.status}".`);
    }
    if (terminalResult === undefined) {
      throw new Error("The HarnessAgent workflow finished without a terminal result.");
    }

    const output = await (outputSchema === undefined ? terminalResult.text : terminalResult.output);
    return {
      output: output as HarnessAgentToolOutput<TOutputSchema>,
      state: nextState,
    };
  } catch (error) {
    await activeSession?.destroy();
    throw error;
  } finally {
    if (nextState?.status !== "ready_for_next_step") {
      await sandboxSession.destroy();
    }
  }
}
