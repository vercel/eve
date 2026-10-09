// v26 event names authored hooks and channels may still use, with what replaced each in v27. A
// definition keyed on one fails as eve loads it, with the replacement, rather than never firing.

const REPLACED: Readonly<Record<string, string>> = {
  "action.input.appended": "`call.input`",
  "action.partial": "`call.progress`",
  "action.result": "`call.settled`, the only place a call's output appears",
  "actions.requested": "`call.requested`, one per call",
  "compaction.completed": '`context.settled` with `kind: "compaction"`',
  "compaction.requested": '`context.started` with `kind: "compaction"`',
  "context.cleared": '`context.settled` with `kind: "clear"`',
  "message.appended": '`content.delta` with `kind: "text"`',
  "message.completed":
    '`content.completed`; `phase: "reply"` marks the reply, instead of `finishReason`',
  "message.received": "`delivery.consumed`",
  "reasoning.appended": '`content.delta` with `kind: "reasoning"`',
  "reasoning.completed": '`content.completed` with `kind: "reasoning"`',
  "result.completed": '`content.completed` with `kind: "result"`',
  "session.completed": '`session.ended` with `outcome: "completed"`',
  "session.failed": '`session.ended` with `outcome: "failed"`',
  "session.waiting":
    "`delivery.settled` (a message's response is done) or `turn.settled`, and `idle(ctx.view)` from `eve/events` (nothing is running)",
  "step.completed": "`model.settled`",
  "step.failed": '`model.settled` with `outcome: "failed"`',
  "step.started": "`model.started`, or `model.requested` before the model is chosen",
  "turn.cancelled": '`turn.settled` with `outcome: "cancelled"`',
  "turn.completed": '`turn.settled` with `outcome: "completed"`',
  "turn.failed": '`turn.settled` with `outcome: "failed"`',
  "turn.waiting": "`turn.paused`",
};

/** Why an authored event key no longer works, and what to key on instead; `undefined` if it does. */
export function removedEventKeyMessage(key: string): string | undefined {
  const replacement = REPLACED[key];
  return replacement === undefined
    ? undefined
    : `"${key}" was removed in session stream version 27. Key on ${replacement}.`;
}
