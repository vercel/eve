import type { ModelMessage } from "ai";

import type { SessionEvent } from "#protocol/session-event.js";

import type { ContextContainer } from "#context/container.js";
import type { ReactionView, ResolveContext, SelectContext } from "#dynamic/definition.js";
import type { WrittenEvent } from "#execution/publish-session-events.js";
import type { JsonValue } from "#shared/json.js";
import type { Slot } from "./state.js";

/** The kinds of contribution, by the code that reads them. */
export type ReactionKind =
  | "hook"
  | "memory"
  | "model"
  | "connection"
  | "subagent"
  | "tool"
  | "skill"
  | "instructions";

/**
 * The order reactions run in after each commit. A reaction may select what an earlier kind
 * contributed, never a later one, so there is no dependency graph to resolve.
 */
export const REACTION_ORDER: readonly ReactionKind[] = [
  "hook",
  "memory",
  "model",
  "connection",
  "subagent",
  "tool",
  "skill",
  "instructions",
];

/** What a reaction contributes: its JSON form, and the code that form can't carry. */
export interface Contribution {
  readonly value: JsonValue;
  readonly live?: unknown;
}

/** What eve's own reactions receive besides the public {@link ResolveContext}. */
export interface InternalResolveContext extends ResolveContext {
  readonly ctx: ContextContainer;
  /** The commit's records with their positions, empty when a restore rebuilds code. */
  readonly written: readonly WrittenEvent[];
  /** The commit's events, for eve's own effects; authored `resolve` never sees them. */
  readonly facts: readonly SessionEvent[];
  /** The conversation, for a reaction that declares it reads one. */
  readonly messages?: readonly ModelMessage[];
  /** The slot as it stood before this run. */
  readonly previous?: Slot;
}

/** One reaction as the runner sees it. Every surface desugars to this. */
export interface Reaction {
  readonly id: string;
  readonly kind: ReactionKind;
  /** Where it was authored, for errors and logs. */
  readonly label: string;
  readonly select?: (view: ReactionView, ctx: SelectContext) => unknown;
  readonly resolve: (selected: unknown, ctx: InternalResolveContext) => unknown;
  /** Validates and names `resolve`'s result. Throws on a result the kind can't read. */
  readonly contribute: (
    result: unknown,
    ctx: InternalResolveContext,
  ) => Contribution | Promise<Contribution>;
  /** Reads the conversation in `resolve`, so it runs only where the step has it. */
  readonly conversation?: boolean;
  /**
   * Reconciles code rebuilt in another process with the JSON the slot recorded, when the two
   * differ. The slot keeps what it recorded; the returned live value replaces the rebuilt one.
   * Without it, the rebuilt contribution replaces the recorded one.
   */
  readonly reconcile?: (recorded: JsonValue, rebuilt: Contribution) => unknown;
  /** A failure fails the commit instead of withdrawing the slot. */
  readonly failure?: "throw";
}

/** The bundle's reactions in run order, and what each kind does once its slots change. */
export interface BundleReactions {
  readonly reactions: readonly Reaction[];
  readonly effects: Partial<Record<ReactionKind, (ctx: ContextContainer) => Promise<void>>>;
}
