import type { ModelMessage } from "ai";

import { contextStorage } from "#context/container.js";
import { buildResponseAuthorizationTools } from "#context/build-dynamic-tools.js";
import type { RequestAt } from "#harness/human-input/index.js";
import type { HarnessSession, HarnessToolMap, ToolLoopHarnessConfig } from "#harness/types.js";
import { createStepStartedEvent } from "#protocol/message.js";

/** What carrying out human input needs from the tool loop that runs the turn. */
export interface StepEffects {
  readonly config: ToolLoopHarnessConfig;
  readonly projectHistory: (
    messages: readonly ModelMessage[],
    state: HarnessSession["state"],
  ) => readonly ModelMessage[];
}

/**
 * The tools of the step at `at`, as its approvals saw them: an answer can
 * arrive steps or turns later, after the tools changed.
 */
export async function prepareStepTools(
  effects: StepEffects,
  at: RequestAt,
  session: HarnessSession,
): Promise<HarnessToolMap> {
  const { config } = effects;
  const ctx = contextStorage.getStore();
  await config.prepareApprovalTurn?.(at);
  if (ctx !== undefined) {
    await config.resolveStepDynamicTools?.({
      ctx,
      event: createStepStartedEvent({
        modelId: session.agent.modelReference?.id ?? "dynamic",
        ...at,
      }),
      messages: effects.projectHistory(session.history, session.state),
    });
  }
  return buildResponseAuthorizationTools({ authoredTools: config.tools, context: ctx });
}
