import { getStepMetadata } from "#compiled/@workflow/core/index.js";
import type { SessionAuthContext, TurnPolicy } from "#channel/types.js";
import { sendToNamedChannel, toCrossChannelTargets } from "#channel/cross-channel-receive.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { resolveDurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { SessionHistoryMessage } from "#shared/session-history.js";

export interface ChannelHandoffInput {
  readonly auth: SessionAuthContext | null;
  /** The session whose workflow tool sent the message, which `receive()` gets as `caller`. */
  readonly callerSessionId: string;
  readonly bundle: AgentSessionContext["bundle"];
  readonly channel: string;
  readonly history?: readonly SessionHistoryMessage[];
  readonly localDevRequest?: AgentSessionContext["localDevRequest"];
  readonly message: string;
  readonly target: Readonly<Record<string, unknown>>;
  readonly turnPolicy?: TurnPolicy;
}

/** Runs the channel's `receive()` against the root agent, outside the calling session's context. */
export async function sendToChannelStep(
  input: ChannelHandoffInput,
): Promise<{ readonly sessionId: string }> {
  "use step";

  const compiledArtifactsSource = resolveDurableCompiledArtifactsSource(input.bundle.source);
  const bundle = await getCompiledRuntimeAgentBundle({ compiledArtifactsSource });
  const session = await contextStorage.run(
    new ContextContainer({ localDevRequest: input.localDevRequest }),
    () =>
      sendToNamedChannel(
        createWorkflowRuntime({ compiledArtifactsSource }),
        toCrossChannelTargets(bundle.graph.root.channels),
        input.channel,
        {
          auth: input.auth,
          caller: { sessionId: input.callerSessionId },
          history: input.history,
          message: input.message,
          target: input.target,
        },
        {
          // A retried step keeps its stepId, so a redelivery to an existing
          // session is deduplicated there.
          idempotencyKey: `eve-channel-handoff:${getStepMetadata().stepId}`,
          turnPolicy: input.turnPolicy,
        },
      ),
  );
  return { sessionId: session.id };
}
