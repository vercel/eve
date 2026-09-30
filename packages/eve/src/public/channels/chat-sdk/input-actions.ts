import type { InputRequest } from "#shared/input.js";
import type { CardChild } from "#compiled/chat/index.js";
import { Actions, Button, Card, CardText } from "#compiled/chat/index.js";

/** Renders pending input requests as a Chat SDK card with one button per option. */
export function renderInputRequests(requests: readonly InputRequest[], inputActionPrefix: string) {
  return Card({
    children: requests.flatMap((request) => renderInputRequest(request, inputActionPrefix)),
  });
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
    return children;
  }
  children.push(
    CardText("This request needs a freeform answer. Continue from the eve session UI."),
  );
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
