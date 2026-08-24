import type { AlsContext } from "#context/container.js";
import { SessionDynamicInstructionsKey } from "#context/keys.js";
import type { MessageStreamEvent } from "#protocol/message.js";

const FRAMEWORK_DATE_TIME_SLOT = "$eve.date-time";

export function buildSessionDateInstructions(
  now: Date,
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
): string {
  const currentDate = now.toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    timeZone,
    weekday: "long",
    year: "numeric",
  });
  const timeZoneName =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(now)
      .find((part) => part.type === "timeZoneName")?.value ?? timeZone;

  return `# Date and time

This session started on ${currentDate} (timezone: ${timeZoneName}).
For the current date or time on a later turn, prefer the latest request context or message timestamp; do not infer a clock time from this session-start instruction.

## Time and calendar

- Ground relative dates like "today", "yesterday", and "last month" in the latest current-time evidence in the request; use the session-start date only when no newer timestamp is available.
- When date interpretation matters, state the concrete date range you used.
- Default to calendar periods unless the user explicitly asks for fiscal periods.`;
}

export function buildCurrentTimeContext(now: Date): string {
  return `Current time: ${now.toISOString()}.`;
}

/** Adds framework-owned temporal grounding to the dynamic instruction preamble. */
export function dispatchDateTimeInstructionEvent(input: {
  readonly ctx: AlsContext;
  readonly event: MessageStreamEvent;
}): void {
  const { ctx, event } = input;
  const now = new Date(event.meta.at);

  if (event.type !== "session.started") return;

  ctx.set(SessionDynamicInstructionsKey, {
    ...ctx.get(SessionDynamicInstructionsKey),
    [FRAMEWORK_DATE_TIME_SLOT]: [{ content: buildSessionDateInstructions(now), role: "system" }],
  });
}
