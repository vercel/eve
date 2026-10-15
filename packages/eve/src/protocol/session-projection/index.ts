// The shared fold, its public tables, and the selectors readers need over them. The tables are
// plain records, so a row is `view.calls[callId]`; selectors answer what takes more than a lookup.

export * from "./fold.js";
export {
  activeTurn,
  activity,
  callLabel,
  callOutputSource,
  callState,
  conversation,
  failure,
  idle,
  openInteractions,
  queue,
  reply,
  tasks,
  waiting,
  type Activity,
  type CallState,
  type Waiting,
} from "./selectors.js";
export type * from "./tables.js";
