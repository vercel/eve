import { resolvedPromptLabel } from "#channel/resolved-prompt.js";
import type { InputResolution } from "#protocol/message.js";
import type { InputRequest } from "#shared/input.js";
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
export function renderInputRequests(
  requests: readonly InputRequest[],
  inputActionPrefix: string,
  resolved: Readonly<Record<string, InputResolution>> = {},
) {
  const outcome = (request: InputRequest) => {
    const resolution = resolved[request.requestId];
    return resolution === undefined ? undefined : resolvedPromptLabel(resolution, request.options);
  };
  return {
    card: Card({
      children: requests.flatMap((request) => {
        const label = outcome(request);
        return label === undefined
          ? renderInputRequest(request, inputActionPrefix)
          : [CardText(request.prompt), CardText(label)];
      }),
    }),
    fallbackText: requests
      .map((request) => {
        const label = outcome(request);
        return label === undefined
          ? renderInputRequestText(request)
          : `${request.prompt}\n\n${label}`;
      })
      .join("\n\n"),
  };
}

// The SDK's card fallback drops buttons, so the options are numbered instead.
function renderInputRequestText(request: InputRequest): string {
  const options = request.options ?? [];
  if (options.length === 0) return `${request.prompt}\n\n${FREEFORM_HINT}`;
  return [
    request.prompt,
    "",
    ...options.map((option, index) => {
      const description = option.description ? ` - ${option.description}` : "";
      return `${index + 1}. ${option.label}${description}`;
    }),
    "",
    request.allowFreeform === true
      ? "Reply with a number, or with your own answer."
      : "Reply with a number to choose.",
  ].join("\n");
}

function renderInputRequest(request: InputRequest, inputActionPrefix: string) {
  const children: CardChild[] = [CardText(request.prompt)];
  if (request.options && request.options.length > 0) {
    children.push(
      Actions(
        request.options.map((option) =>
          Button({
            id: encodeInputAction(inputActionPrefix, request.requestId, option.id),
            label: option.label,
            style: option.style,
            value: option.id,
          }),
        ),
      ),
    );
    if (request.allowFreeform === true) children.push(CardText("Or reply with your own answer."));
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
): { optionId: string; requestId: string } | null {
  if (!actionId.startsWith(prefix)) return null;
  const encoded = actionId.slice(prefix.length);
  const separator = encoded.indexOf(":");
  if (separator <= 0) return null;
  try {
    const requestId = decodeURIComponent(encoded.slice(0, separator));
    const optionId = value ?? decodeURIComponent(encoded.slice(separator + 1));
    return { optionId, requestId };
  } catch {
    return null;
  }
}
