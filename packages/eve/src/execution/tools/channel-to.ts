import {
  createCrossChannelToFn,
  toCrossChannelTargets,
  type CrossChannelToFn,
} from "#channel/cross-channel-receive.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

export function createToolChannelTo(input: {
  readonly delegated: boolean;
  readonly loadBundle: () => CompiledRuntimeAgentBundle | Promise<CompiledRuntimeAgentBundle>;
}): CrossChannelToFn {
  return (channel, target) => {
    if (input.delegated) {
      throw new Error(
        "ctx.to() isn't available in a delegated session (a subagent, a root copy, or a remote " +
          "agent call): a session it started would outlive the delegation and act for the caller. " +
          "Return the result to the caller, and send from a tool on the root agent.",
      );
    }
    return {
      async send(message, options) {
        const bundle = await input.loadBundle();
        const to = createCrossChannelToFn(
          createWorkflowRuntime({ compiledArtifactsSource: bundle.compiledArtifactsSource }),
          toCrossChannelTargets(bundle.graph.root.channels),
        );
        return await contextStorage.run(new ContextContainer(), () =>
          to(channel, target).send(message, options),
        );
      },
    };
  };
}
