export const EMPTY_DELIVERY_SENTINEL = "<eve-empty-delivery/>";
const HTML_ESCAPED_EMPTY_DELIVERY_SENTINEL = "&lt;eve-empty-delivery/&gt;";

export const CONDITIONAL_DELIVERY_INSTRUCTION = `Conditional delivery\nOnly when the current task explicitly makes delivery conditional and there is nothing new to report, reply with exactly ${EMPTY_DELIVERY_SENTINEL} and no other text. This includes results already delivered or incorporated into an earlier response; do not send an acknowledgement of that redundancy. Do not use this marker for ordinary conversations, after input or approval responses, or to omit commentary from a response that still needs delivery. Never return an empty response; use the marker to intentionally deliver nothing.`;

export const TASK_DELIVERY_INSTRUCTION = `Background task reporting\nThis turn was triggered by background task activity. The accompanying [Task state] message is runtime-authored and lists tasks started by the same parent turn. A pending task has not delivered a terminal result to this parent. When no task is pending, the state also includes every available terminal output.\nFor related tasks:\n- If any task is pending, reply with exactly ${EMPTY_DELIVERY_SENTINEL} and no other text.\n- When no task is pending, do not use the sentinel. Send one user-facing response that combines their useful results.`;

export function hasEmptyDeliverySentinel(text: string | null | undefined): boolean {
  return (
    text?.includes(EMPTY_DELIVERY_SENTINEL) === true ||
    text?.includes(HTML_ESCAPED_EMPTY_DELIVERY_SENTINEL) === true
  );
}
