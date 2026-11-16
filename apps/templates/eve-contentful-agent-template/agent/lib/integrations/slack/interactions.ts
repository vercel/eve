import { ANSWER_ACTION_PREFIX } from "eve/channels/slack";
import type {
  BlockKitBlock,
  SlackRenderer,
  SlackThread,
} from "eve/channels/slack";
import { interaction, interactions } from "eve/events";
import type { Interaction, SessionView } from "eve/events";
import { z } from "zod";

import type { JsonObject, JsonValue } from "../../json";
import { defineState } from "../../state";
import { isObject, isString } from "../../values";

/**
 * Message posted in the thread before eve's controls for one approval or question.
 */
interface InteractionDetails {
  /** Block Kit blocks for the message, at most 50. */
  blocks: unknown[];
  /** Runs after Slack confirms the preview and eve renders the group's controls, including on replay. */
  onPosted?: (messageId: string) => void;
  /** Notification and accessibility text for the message. */
  text: string;
}

/**
 * Optional presentation additions for Slack approvals and questions.
 *
 * @remarks eve posts, groups, and updates the controls for every request, including who answered. These hooks only add a details message and relabel eve's controls.
 */
export interface SlackInteractionsConfig {
  /**
   * Returns a message to post before eve's controls, or undefined to post eve's controls alone.
   *
   * @remarks A thrown error stops eve's controls from posting, so a request whose details can't be confirmed is never offered for an answer from its card.
   */
  details?: (
    interaction: Interaction
  ) => InteractionDetails | undefined | Promise<InteractionDetails | undefined>;
  /** Returns labels for a request's options keyed by option ID, or undefined to keep eve's labels. They replace the text on eve's buttons and in the line eve shows once someone answers. */
  labels?: (
    interaction: Interaction
  ) => Readonly<Record<string, string>> | undefined;
}

const deliveries = defineState<Record<string, string>>(
  "slack.input-request-deliveries",
  () => ({})
);

type Labels = Readonly<Record<string, string>>;

/* Slack blocks as JSON, so relabeling reads typed values. */
const blocksSchema = z.array(z.record(z.string(), z.json()));

/* Replace the label of each eve button whose option has one, keeping every control and value. eve draws approval buttons with fixed Approve and Deny labels. */
const relabelObject = (object: JsonObject, labels: Labels): JsonObject => {
  const relabel = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) {
      return value.map(relabel);
    }
    return isObject(value) ? relabelObject(value, labels) : value;
  };
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(object)) {
    result[key] = relabel(item);
  }
  const label =
    isString(result.value) && Object.hasOwn(labels, result.value)
      ? labels[result.value]
      : undefined;
  if (
    result.type === "button" &&
    label !== undefined &&
    isString(result.action_id) &&
    result.action_id.startsWith(ANSWER_ACTION_PREFIX) &&
    isObject(result.text) &&
    !Array.isArray(result.text)
  ) {
    result.text = { ...result.text, text: label };
  }
  return result;
};

const relabelBlocks = (
  blocks: readonly BlockKitBlock[],
  labels: Labels
): JsonObject[] =>
  blocksSchema.parse(blocks).map((block) => relabelObject(block, labels));

/* The request with each labeled option renamed, so eve's answered line shows the label of the option someone chose. */
const relabelRequest = (request: Interaction, labels: Labels): Interaction => ({
  ...request,
  request: {
    ...request.request,
    options: request.request.options?.map((option) =>
      Object.hasOwn(labels, option.id)
        ? { ...option, label: labels[option.id] ?? option.label }
        : option
    ),
  },
});

/**
 * Lists the open requests eve posts together with one request: those asked in the same model step of the same turn and task.
 *
 * @param view - Session snapshot of the commit the request opened in.
 * @param request - Request whose event is being rendered.
 * @returns Open approvals, questions, and budget prompts from the same step, in the order eve opened them, always including `request`.
 * @remarks eve groups the requests a step opens and posts their controls while handling the first of them. Requests from other steps or turns keep their own events, so a request whose details can't be built never blocks another step's controls.
 */
const batchOf = (view: SessionView, request: Interaction): Interaction[] => {
  const batch = interactions(view).filter(
    (other) =>
      other.status === "open" &&
      other.request.kind !== "sign-in" &&
      other.turnId === request.turnId &&
      other.stepIndex === request.stepIndex &&
      other.taskId === request.taskId
  );
  return batch.some((other) => other.interactionId === request.interactionId)
    ? batch
    : [...batch, request];
};

/**
 * Posts one request's details unless an earlier event already did, and reports the confirmed message.
 *
 * @param request - Open approval or question whose details to deliver.
 * @param details - Hook that returns the details, or undefined when the request has none.
 * @param thread - Slack thread the details post to.
 * @returns A checkpoint to run after native controls render, or undefined when no details apply.
 * @throws {@link Error} When the details exceed Slack's block limit or Slack doesn't confirm delivery.
 */
const deliverDetails = async (
  request: Interaction,
  details: NonNullable<SlackInteractionsConfig["details"]>,
  thread: SlackThread
): Promise<(() => void) | undefined> => {
  const presentation = await details(request);
  if (!presentation) {
    return;
  }
  const { interactionId } = request;
  const delivered = deliveries.get()[interactionId];
  if (delivered) {
    return () => presentation.onPosted?.(delivered);
  }
  if (presentation.blocks.length > 50) {
    throw new Error(
      "Interaction details exceed Slack's 50-block message limit."
    );
  }
  const posted = await thread.post({
    blocks: presentation.blocks,
    text: presentation.text,
  });
  if (posted.raw.ok !== true || !posted.id) {
    throw new Error(
      "Could not confirm delivery of the Slack interaction details."
    );
  }
  deliveries.update((current) =>
    Object.fromEntries(
      [...Object.entries(current), [interactionId, posted.id]].slice(-50)
    )
  );
  return () => presentation.onPosted?.(posted.id);
};

/**
 * Creates a Slack renderer that posts optional details before eve's approval and question controls and relabels those controls.
 *
 * @param config - Optional details and labels for requests such as Contentful publication plans.
 * @returns A renderer that wraps eve's default interaction rendering.
 * @remarks eve posts the controls for every request opened in the same step while it handles the first of them, so each event delivers the details of every open request from its step before handing on, and a failed delivery stops eve's controls for that group. Saved deliveries keep each details message to one post. eve remains responsible for signed responder authentication, answer admission, and updating its cards once a request is answered or ends. Details messages stay in the thread as a record of what was asked.
 */
export const createInteractionRenderer = (
  config: SlackInteractionsConfig = {}
): SlackRenderer => ({
  events: {
    async "interaction.opened"(event, ctx, renderNext) {
      const { details } = config;
      if (
        !details ||
        event.data.request.kind === "sign-in" ||
        !("thread" in ctx.channel)
      ) {
        return renderNext();
      }
      const current = interaction(ctx.view, event.data.interactionId);
      if (!current) {
        throw new Error("Could not read the pending Slack interaction.");
      }
      const confirmations: (() => void)[] = [];
      for await (const request of batchOf(ctx.view, current)) {
        const confirm = await deliverDetails(
          request,
          details,
          ctx.channel.thread
        );
        if (confirm) {
          confirmations.push(confirm);
        }
      }
      await renderNext();
      for (const confirm of confirmations) {
        confirm();
      }
    },
  },
  interactionCard(card, renderDefault) {
    const labels = config.labels?.(card.interaction);
    if (!labels) {
      return renderDefault(card);
    }
    const parts = renderDefault({
      ...card,
      interaction: relabelRequest(card.interaction, labels),
    });
    if (card.interaction.status !== "open") {
      return parts;
    }
    return {
      ...parts,
      controls: {
        ...parts.controls,
        blocks: relabelBlocks(parts.controls.blocks, labels),
      },
    };
  },
});
