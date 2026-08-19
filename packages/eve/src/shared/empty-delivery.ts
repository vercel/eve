export const EMPTY_DELIVERY_SENTINEL = "<eve-empty-delivery/>";

export const CONDITIONAL_DELIVERY_INSTRUCTION = `Conditional delivery\nOnly when the current task explicitly makes delivery conditional and there is nothing new to report, reply with exactly ${EMPTY_DELIVERY_SENTINEL} and no other text. This includes results already delivered or incorporated into an earlier response; do not send an acknowledgement of that redundancy. Do not use this marker for ordinary conversations, after input or approval responses, or to omit commentary from a response that still needs delivery. Never return an empty response; use the marker to intentionally deliver nothing.`;

export function hasEmptyDeliverySentinel(text: string | null | undefined): boolean {
  return text?.includes(EMPTY_DELIVERY_SENTINEL) ?? false;
}
