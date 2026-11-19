import {
  createCrossChannelToFn,
  toCrossChannelTargets,
  type CrossChannelToFn,
} from "#channel/cross-channel-receive.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import type { CreateRuntime } from "#execution/node-step.js";
import type { SessionAgent } from "#runtime/sessions/session-agent.js";

export function createToolChannelTo(input: {
  readonly createRuntime: CreateRuntime;
  readonly delegated: boolean;
  readonly loadAgent: () => SessionAgent | Promise<SessionAgent>;
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
        const bundle = (await input.loadAgent()).compiled;
        if (bundle === undefined) {
          throw new Error(
            "ctx.to() reaches the channels of an agent compiled from files; an agent this process holds has none.",
          );
        }
        const to = createCrossChannelToFn(
          input.createRuntime({ compiledArtifactsSource: bundle.compiledArtifactsSource }),
          toCrossChannelTargets(bundle.graph.root.channels),
        );
        return await contextStorage.run(new ContextContainer(), () =>
          to(channel, target).send(message, options),
        );
      },
    };
  };
}
