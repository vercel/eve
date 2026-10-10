// The unions of every fact and progress type. Types only.

import type { CommitLine, ProgressLine, StoredLine } from "./envelope.js";
import type { CallFact, CallProgressRecord } from "./families/call.js";
import type { ChildFact } from "./families/child.js";
import type { ContentFact, ContentProgress } from "./families/content.js";
import type { ContextFact } from "./families/context.js";
import type { DeliveryFact } from "./families/delivery.js";
import type { InteractionFact } from "./families/interaction.js";
import type { ModelFact } from "./families/model.js";
import type { ResponseFact } from "./families/response.js";
import type { SessionFact } from "./families/session.js";
import type { TaskFact } from "./families/task.js";
import type { TurnFact } from "./families/turn.js";
import type { UsageFact } from "./families/usage.js";

/** A decision the machine made, or an observation it accepted. Facts are grouped by commit. */
export type Fact =
  | SessionFact
  | DeliveryFact
  | TurnFact
  | ModelFact
  | ContentFact
  | CallFact
  | TaskFact
  | InteractionFact
  | ResponseFact
  | ChildFact
  | ContextFact
  | UsageFact;

/** A preview of a value a fact will complete. Never folded into the lifecycle tables. */
export type Progress = ContentProgress | CallProgressRecord;

/** The fact of one type. */
export type FactOf<TType extends Fact["type"]> = Extract<Fact, { readonly type: TType }>;

/** The progress record of one type. */
export type ProgressOf<TType extends Progress["type"]> = Extract<
  Progress,
  { readonly type: TType }
>;

/** One line of a v27 session stream. */
export type SessionLine = StoredLine<Fact, Progress>;
export type SessionCommit = CommitLine<Fact>;
export type SessionProgress = ProgressLine<Progress>;
