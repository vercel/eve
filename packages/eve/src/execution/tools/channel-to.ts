import {
  createCrossChannelToFn,
  toCrossChannelTargets,
  type CrossChannelToFn,
} from "#channel/cross-channel-receive.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

/**
 * `ctx.to()` for a tool or a workflow tool's step: the root agent's channels,
 * reached through their `receive()` hooks as a route's `ctx.to()` reaches them.
 */
export function createToolChannelTo(input: {
  /** Whether a parent, local or remote, delegated the session running the tool. */
  readonly delegated: boolean;
  /** The compiled agent that owns the tool. */
  readonly loadBundle: () => CompiledRuntimeAgentBundle | Promise<CompiledRuntimeAgentBundle>;
}): CrossChannelToFn {
  return (channel, target) => {
    // A channel session runs the root agent with all its tools, as whoever the
    // sender names, and outlives the delegation. A delegated session would
    // reach tools and identities its parent never gave it.
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
        // The session belongs to the channel, so it starts outside the tool's
        // session context and inherits none of its lineage.
        return await contextStorage.run(new ContextContainer(), () =>
          to(channel, target).send(message, options),
        );
      },
    };
  };
}
