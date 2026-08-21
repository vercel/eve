import type { ModelMessage } from "ai";

import type { AlsContext } from "#context/container.js";
import {
  dispatchDynamicToolEvent,
  resolveStepDynamicTools,
} from "#context/dynamic-tool-lifecycle.js";
import {
  dispatchRuntimeToolContributors,
  refreshRuntimeToolContributionsForRuntimeRevision,
  type RuntimeToolContributor,
} from "#context/runtime-tool-contribution.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { ResolvedDynamicToolResolver } from "#runtime/types.js";

interface RuntimeToolLifecycleInput {
  readonly contributors: readonly RuntimeToolContributor[];
  readonly ctx: AlsContext;
  readonly resolvers: readonly ResolvedDynamicToolResolver[];
  readonly runtimeRevision: string;
}

interface RuntimeToolEventInput {
  readonly ctx: AlsContext;
  readonly event: UnstampedMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
}

export function createRuntimeToolLifecycle(input: RuntimeToolLifecycleInput) {
  const resolveStep = async (eventInput: RuntimeToolEventInput): Promise<void> => {
    await resolveStepDynamicTools({
      ctx: eventInput.ctx,
      event: eventInput.event,
      messages: eventInput.messages,
      resolvers: input.resolvers,
    });
    await dispatchRuntimeToolContributors({
      contributors: input.contributors,
      ctx: eventInput.ctx,
      event: eventInput.event,
      messages: eventInput.messages,
      runtimeRevision: input.runtimeRevision,
    });
  };

  return {
    async dispatch(eventInput: RuntimeToolEventInput): Promise<void> {
      if (eventInput.event.type === "step.started") {
        await resolveStep(eventInput);
        return;
      }
      await dispatchDynamicToolEvent({
        ctx: eventInput.ctx,
        event: eventInput.event,
        messages: eventInput.messages,
        resolvers: input.resolvers,
      });
      await dispatchRuntimeToolContributors({
        contributors: input.contributors,
        ctx: eventInput.ctx,
        event: eventInput.event,
        messages: eventInput.messages,
        runtimeRevision: input.runtimeRevision,
      });
    },
    refresh: () =>
      refreshRuntimeToolContributionsForRuntimeRevision({
        contributors: input.contributors,
        ctx: input.ctx,
        runtimeRevision: input.runtimeRevision,
      }),
    resolveStep,
  };
}
