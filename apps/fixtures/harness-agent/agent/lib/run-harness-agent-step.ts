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
import type { FlexibleSchema } from "ai";
import { isStepCount, Output } from "ai";
import type { WorkflowToolContext } from "eve/tools";

import { adaptHarnessNetworkSandboxSession } from "./sandbox-session";
import type {
  CreateHarnessAgentToolSettings,
  HarnessBridgeSettings,
  HarnessAgentToolOutput,
  OptionalOutputSchema,
} from "./types";

type HarnessAgentWorkflowStepResult<TOutput> =
  | { readonly state: HarnessWorkflowState }
  | { readonly output: TOutput; readonly state: HarnessWorkflowState };

type HarnessAgentTerminalResult = HarnessWorkflowStreamResult & {
  readonly output: PromiseLike<unknown>;
  readonly text: PromiseLike<string>;
};

type RunHarnessAgentStepSettings<TOutputSchema extends OptionalOutputSchema = undefined> = Omit<
  CreateHarnessAgentToolSettings<TOutputSchema>,
  "description"
> & {
  readonly ctx: WorkflowToolContext;
  readonly harness: (settings: HarnessBridgeSettings) => HarnessAgentAdapter;
  readonly state: HarnessWorkflowState;
};

export async function runHarnessAgentStep<TOutputSchema extends OptionalOutputSchema = undefined>(
  input: RunHarnessAgentStepSettings<TOutputSchema>,
): Promise<HarnessAgentWorkflowStepResult<HarnessAgentToolOutput<TOutputSchema>>> {
  const sandboxSession = await adaptHarnessNetworkSandboxSession({
    leaseId: input.state.sessionId,
    sandbox: await input.ctx.getSandbox(),
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
      stopWhen: isStepCount(1),
    });
    const workflowAgent: HarnessWorkflowAgent = {
      async createSession(options) {
        activeSession = await agent.createSession({
          ...options,
          abortSignal: input.ctx.abortSignal,
          sandboxSession,
        });
        return activeSession;
      },
      async continueStream(options) {
        const result = await agent.continueStream({
          ...options,
          abortSignal: input.ctx.abortSignal,
        });
        terminalResult = result;
        return result;
      },
      async stream(options) {
        const result = await agent.stream({
          ...options,
          abortSignal: input.ctx.abortSignal,
        });
        terminalResult = result;
        return result;
      },
    };

    nextState = await runWorkflowHarnessAgentStep({
      agent: workflowAgent,
      destroyOnFinish: true,
      state: input.state,
      writable: new WritableStream(),
    });

    if (nextState.status === "awaiting_tool_approval") {
      if (nextState.continueFrom === undefined) {
        throw new Error(
          "The HarnessAgent workflow requested tool approval without continuation state.",
        );
      }
      const session = await agent.createSession({
        abortSignal: input.ctx.abortSignal,
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

    const output = await (input.outputSchema === undefined
      ? terminalResult.text
      : terminalResult.output);
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
