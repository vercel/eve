import { HITL_ACTION_PREFIX } from "eve/channels/slack";
import type { SlackRendererEvents } from "eve/channels/slack";
import { z } from "zod";

import type { JsonObject, JsonValue } from "../../json";
import { defineState } from "../../state";
import { isObject, isString } from "../../values";

/**
 * One pending question or tool approval delivered by eve's Slack renderer.
 */
export type SlackInputRequest = Parameters<
  NonNullable<SlackRendererEvents["input.requested"]>
>[0]["requests"][number];

interface InputPresentation {
  blocks: unknown[];
  /* Runs only after Slack has confirmed delivery (also on a replay). */
  onPosted?: (messageId: string) => void;
  text: string;
}

/**
 * Optional presentation overrides for Slack questions and tool approvals.
 */
export interface SlackInputRequestsConfig {
  /** Return undefined to use the shared presentation; thrown errors must not fall back to an incomplete approval preview. */
  render?: (
    request: SlackInputRequest
  ) => InputPresentation | undefined | Promise<InputPresentation | undefined>;
}

const deliveries = defineState<Record<string, string>>(
  "slack.input-request-deliveries",
  () => ({})
);

const plain = (text: string, limit = 3000) => ({
  emoji: false,
  text:
    text.length > limit ? `${text.slice(0, limit - 16)}… [truncated]` : text,
  type: "plain_text" as const,
});

/**
 * Builds the action identifier prefix expected by eve's Slack response decoder.
 *
 * @param request - Pending input request whose ID and kind identify subsequent interactions.
 * @returns The framework action prefix, including the tool-approval discriminator when required.
 */
const actionPrefix = (request: SlackInputRequest) =>
  `${HITL_ACTION_PREFIX}${request.kind === "tool-approval" ? "tool-approval:" : ""}${request.requestId}`;

/**
 * Renders request options as Slack buttons using eve-compatible action identifiers.
 *
 * @param request - Pending request containing the stable option IDs and display labels.
 * @param labels - Optional display-label overrides keyed by option ID.
 * @returns Buttons preserving option values, ordering, and applicable primary or danger styles.
 */
export const inputRequestButtons = (
  request: SlackInputRequest,
  labels: Record<string, string> = {}
) =>
  (request.options ?? []).map((option, index) => ({
    action_id: `${actionPrefix(request)}:button:${index}`,
    ...(request.kind === "tool-approval" &&
      option.id === "approve" && { style: "primary" }),
    ...((option.style === "primary" || option.style === "danger") && {
      style: option.style,
    }),
    text: plain(labels[option.id] ?? option.label, 75),
    type: "button",
    value: option.id,
  }));

const inputControls = (request: SlackInputRequest): JsonValue[] => {
  const options = request.options ?? [];
  if (options.length > 100) {
    throw new Error("Slack input requests support at most 100 choices.");
  }
  const elements: JsonValue[] = [];
  if (options.length > 0) {
    if (request.display === "select" || options.length > 5) {
      const radio = options.length <= 6;
      elements.push({
        action_id: actionPrefix(request),
        options: options.map((option) => ({
          ...(option.description && {
            description: plain(option.description, 75),
          }),
          text: plain(option.label, 75),
          value: option.id,
        })),
        ...(!radio && { placeholder: plain("Choose an option", 150) }),
        type: radio ? "radio_buttons" : "static_select",
      });
    } else {
      elements.push(...inputRequestButtons(request));
    }
  }
  if (
    request.kind !== "tool-approval" &&
    (request.allowFreeform || options.length === 0)
  ) {
    elements.push({
      action_id: `eve_input_freeform:${request.requestId}`,
      text: plain("Type your answer", 75),
      type: "button",
      value: request.requestId,
    });
  }
  // Keep alternative controls together so eve removes all of them on answer.
  return elements.length ? [{ elements, type: "actions" }] : [];
};

const standardPresentation = (
  request: SlackInputRequest
): InputPresentation => {
  const blocks: unknown[] = [{ text: plain(request.prompt), type: "section" }];
  const text = [request.prompt];
  if (request.kind === "tool-approval") {
    const details = `Tool: ${request.action.toolName}\n${JSON.stringify(request.action.input, null, 2)}`;
    // Match eve's bounded input preview, and explicitly identify truncation.
    blocks.push({ text: plain(details), type: "section" });
    text.push(plain(details).text);
  }
  blocks.push(...inputControls(request));
  text.push(
    ...(request.options ?? []).map(
      (option) =>
        `${option.label}${option.description ? `: ${option.description}` : ""}`
    )
  );
  return {
    blocks,
    text: plain(text.join("\n"), 39_000)
      .text.replaceAll("<", "‹")
      .replaceAll(">", "›"),
  };
};

const record = (value: unknown): value is JsonObject =>
  isObject(value) && value !== null;

/* Remove only this request's controls, including controls inside containers. */
const settledBlocks = (
  blocks: readonly JsonValue[],
  requestId: string
): JsonValue[] => {
  const prefixes = [
    `${HITL_ACTION_PREFIX}${requestId}`,
    `${HITL_ACTION_PREFIX}tool-approval:${requestId}`,
  ];
  return blocks.flatMap<JsonValue>((block) => {
    if (!record(block)) {
      return [block];
    }
    const result = { ...block };
    if (Array.isArray(result.child_blocks)) {
      result.child_blocks = settledBlocks(result.child_blocks, requestId);
    }
    for (const key of ["actions", "elements"]) {
      if (!Array.isArray(result[key])) {
        continue;
      }
      const elements = result[key].filter(
        (element) =>
          !(
            record(element) &&
            isString(element.action_id) &&
            prefixes.some(
              (prefix) =>
                element.action_id === prefix ||
                // SAFETY: The enclosing isString check validates action_id before this synchronous prefix callback.
                (element.action_id as string).startsWith(`${prefix}:button:`)
            )
          )
      );
      result[key] = elements;
      if (elements.length === 0) {
        Reflect.deleteProperty(result, key);
      }
    }
    if (result.type === "actions" && !result.elements) {
      return [];
    }
    return [result];
  });
};

/**
 * Creates renderers for pending, rejected, answered, and settled Slack input requests.
 *
 * @param config - Optional custom presentation for requests such as Contentful publication plans.
 * @returns Native Slack event handlers with durable delivery receipts and settled-control cleanup.
 * @remarks eve remains responsible for signed responder authentication and approval admission.
 */
export const createInputRequestEvents = (
  config: SlackInputRequestsConfig = {}
) =>
  ({
    async "approval.candidate"(event, channel) {
      const userId =
        channel.state.slackUsersByPrincipal?.[event.responderPrincipalId];
      if (!userId) {
        return;
      }
      const text =
        event.outcome === "pending"
          ? "Checking whether you can approve this action…"
          : (event.reason ??
            (event.outcome === "stale"
              ? "This approval response is no longer current. Check the latest request in this thread."
              : "Your approval could not be verified. Please try again."));
      await channel.thread.postEphemeral(userId, {
        blocks: [{ text: plain(text), type: "section" }],
        text: text.replaceAll("<", "‹").replaceAll(">", "›"),
      });
    },
    async "approval.settled"(event, channel) {
      const cards = channel.state.pendingApprovalCards ?? {};
      const card = cards[event.requestId];
      if (!card) {
        return;
      }
      const label = event.outcome === "approved" ? "Approved" : "Cancelled";
      const userId =
        channel.state.slackUsersByPrincipal?.[event.responderPrincipalId];
      const blocks = [
        ...settledBlocks(
          z.array(z.json()).parse(card.messageBlocks),
          event.requestId
        ),
        {
          elements: [
            {
              text: `${label}${userId ? ` by <@${userId}>` : ""}`,
              type: "mrkdwn",
            },
          ],
          type: "context",
        },
      ];
      const result = await channel.slack.request("chat.update", {
        blocks,
        channel: channel.slack.channelId,
        text: label,
        ts: card.messageTs,
      });
      if (result.ok !== true) {
        throw new Error(
          `Could not update the Slack approval card: ${String(result.error ?? "unknown error")}`
        );
      }
      // Keep sibling approvals from overwriting each other's settled state.
      const next = { ...cards };
      Reflect.deleteProperty(next, event.requestId);
      for (const [id, other] of Object.entries(next)) {
        if (other.messageTs === card.messageTs) {
          next[id] = { ...other, messageBlocks: blocks };
        }
      }
      channel.state.pendingApprovalCards = next;
    },
    async "input.requested"(event, channel) {
      for await (const request of event.requests) {
        const custom = await config.render?.(request);
        const presentation = custom ?? standardPresentation(request);
        const delivered = deliveries.get()[request.requestId];
        if (delivered) {
          presentation.onPosted?.(delivered);
          continue;
        }
        if (presentation.blocks.length > 50) {
          throw new Error(
            "Input request exceeds Slack's 50-block message limit."
          );
        }
        const posted = await channel.thread.post({
          blocks: presentation.blocks,
          text: presentation.text,
        });
        if (posted.raw.ok !== true || !posted.id) {
          throw new Error(
            "Could not confirm delivery of the Slack input request."
          );
        }
        if (request.kind === "tool-approval") {
          channel.state.pendingApprovalCards = {
            ...channel.state.pendingApprovalCards,
            [request.requestId]: {
              messageBlocks: presentation.blocks,
              messageTs: posted.id,
            },
          };
        }
        deliveries.update((current) => ({
          ...current,
          [request.requestId]: posted.id,
        }));
        presentation.onPosted?.(posted.id);
      }
    },
  }) satisfies SlackRendererEvents;
