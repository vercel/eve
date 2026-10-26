import { resolvedPromptLabel } from "#channel/resolved-prompt.js";
import { optionStyle, type RequestSettlement } from "#channel/interaction-prompts.js";
import type { Interaction } from "#channel/interaction-prompts.js";
import type { CardChild } from "#compiled/chat/index.js";
import { Actions, Button, Card, CardText } from "#compiled/chat/index.js";

// A text reply answers a pending request: an option's number, label, or id, or
// any text when the request has no options or allows a freeform answer.
const FREEFORM_HINT = "Reply with your answer.";

/**
 * Renders pending input requests as a Chat SDK card with one button per option,
 * plus fallback text for adapters without cards (such as Photon iMessage). A
 * request in `resolved` shows its outcome in place of its buttons.
 */
export function renderInteractions(
  requests: readonly Interaction[],
  inputActionPrefix: string,
  resolved: Readonly<Record<string, RequestSettlement>> = {},
) {
  const outcome = (request: Interaction) => {
    const resolution = resolved[request.interactionId];
    return resolution === undefined
      ? undefined
      : resolvedPromptLabel(resolution, request.request.options);
  };
  return {
    card: Card({
      children: requests.flatMap((request) => {
        const label = outcome(request);
        return label === undefined
          ? renderInteraction(request, inputActionPrefix)
          : [CardText(request.request.prompt), CardText(label)];
      }),
    }),
    fallbackText: requests
      .map((request) => {
        const label = outcome(request);
        return label === undefined
          ? renderInteractionText(request)
          : `${request.request.prompt}\n\n${label}`;
      })
      .join("\n\n"),
  };
}

/** Renders a request card whose prompt is unknown as only how it ended. */
export function renderRetiredInputRequest(label: string) {
  return { card: Card({ children: [CardText(label)] }), fallbackText: label };
}

// The SDK's card fallback drops buttons, so the options are numbered instead.
function renderInteractionText(request: Interaction): string {
  const options = request.request.options ?? [];
  if (options.length === 0) return `${request.request.prompt}\n\n${FREEFORM_HINT}`;
  return [
    request.request.prompt,
    "",
    ...options.map((option, index) => {
      const description = option.description ? ` - ${option.description}` : "";
      return `${index + 1}. ${option.label}${description}`;
    }),
    "",
    request.request.allowFreeform === true
      ? "Reply with a number, or with your own answer."
      : "Reply with a number to choose.",
  ].join("\n");
}

function renderInteraction(request: Interaction, inputActionPrefix: string) {
  const children: CardChild[] = [CardText(request.request.prompt)];
  if (request.request.options && request.request.options.length > 0) {
    children.push(
      Actions(
        request.request.options.map((option) =>
          Button({
            id: encodeInputAction(inputActionPrefix, request.interactionId, option.id),
            label: option.label,
            style: optionStyle(option),
            value: option.id,
          }),
        ),
      ),
    );
    if (request.request.allowFreeform === true)
      children.push(CardText("Or reply with your own answer."));
    return children;
  }
  children.push(CardText(FREEFORM_HINT));
  return children;
}

function encodeInputAction(prefix: string, requestId: string, optionId: string): string {
  return `${prefix}${encodeURIComponent(requestId)}:${encodeURIComponent(optionId)}`;
}

/** Decodes a default eve HITL button action back into an input response. */
export function decodeInputAction(
  actionId: string,
  prefix: string,
  value: string | undefined,
): { interactionId: string; optionId: string } | null {
  if (!actionId.startsWith(prefix)) return null;
  const encoded = actionId.slice(prefix.length);
  const separator = encoded.indexOf(":");
  if (separator <= 0) return null;
  try {
    const requestId = decodeURIComponent(encoded.slice(0, separator));
    const optionId = value ?? decodeURIComponent(encoded.slice(separator + 1));
    return { interactionId: requestId, optionId };
  } catch {
    return null;
  }
}
