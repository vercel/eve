import type { SlackRendererEvents } from "eve/channels/slack";
import { interaction } from "eve/events";

import { defineState } from "../../state";

/** Approval or question projected from eve's session facts. */
export type SlackInputRequest = NonNullable<ReturnType<typeof interaction>>;

interface InputPresentation {
  blocks: unknown[];
  /** Runs only after Slack confirms delivery of the preview and eve renders its controls. */
  onPosted?: (messageId: string) => void;
  text: string;
}

/** Optional context posted before eve's native, authenticated interaction controls. */
export interface SlackInputRequestsConfig {
  render?: (
    request: SlackInputRequest
  ) => InputPresentation | undefined | Promise<InputPresentation | undefined>;
}

const deliveries = defineState<Record<string, string>>(
  "slack.input-request-deliveries",
  () => ({})
);

/**
 * Posts custom approval context while leaving controls, responses, and settlement to eve.
 *
 * @param config - Optional preview renderer; exceptions fail closed instead of hiding required context.
 * @returns Interaction handlers that checkpoint only confirmed preview deliveries.
 */
export const createInputRequestEvents = (
  config: SlackInputRequestsConfig = {}
) =>
  ({
    async "interaction.opened"(event, ctx, renderNext) {
      if (event.data.request.kind === "sign-in" || !("thread" in ctx.channel)) {
        return renderNext();
      }
      const request = interaction(ctx.view, event.data.interactionId);
      if (!request) {
        throw new Error("Could not read the pending Slack interaction.");
      }
      const presentation = await config.render?.(request);
      if (!presentation) {
        return renderNext();
      }
      let delivered = deliveries.get()[request.interactionId];
      if (!delivered) {
        if (presentation.blocks.length > 50) {
          throw new Error(
            "Input request exceeds Slack's 50-block message limit."
          );
        }
        const posted = await ctx.channel.thread.post({
          blocks: presentation.blocks,
          text: presentation.text,
        });
        if (posted.raw.ok !== true || !posted.id) {
          throw new Error(
            "Could not confirm delivery of the Slack input request."
          );
        }
        delivered = posted.id;
        deliveries.update((current) =>
          Object.fromEntries(
            [
              ...Object.entries(current),
              [request.interactionId, delivered],
            ].slice(-50)
          )
        );
      }
      await renderNext();
      return presentation.onPosted?.(delivered);
    },
  }) satisfies SlackRendererEvents;
