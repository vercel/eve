import type { ModelMessage } from "ai";

import type { SessionEvent } from "#protocol/session-event.js";

import type { ContextContainer } from "#context/container.js";
import type { DynamicContext } from "#dynamic/definition.js";
import type { WrittenEvent } from "#execution/publish-session-events.js";
import type { DynamicEvaluateFn } from "#runtime/types.js";
import type { JsonValue } from "#shared/json.js";

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
 * The order reactions run in. Hooks run after each commit, before dynamic values; the model is
 * chosen first among values, so every later kind can read it.
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

/** What a dynamic value contributes: its JSON form, and the code that form can't carry. */
export interface Contribution {
  readonly value: JsonValue;
  readonly live?: unknown;
}

/**
 * What eve's own definitions receive: the public context, and the step's state. Authored
 * definitions receive only the public part.
 */
export interface InternalContext extends DynamicContext {
  readonly abortSignal: AbortSignal;
  readonly ctx: ContextContainer;
  /** The conversation, where the step holds it. */
  readonly history: readonly ModelMessage[] | undefined;
}

/** What eve's own commit-time effects receive: the step's state and the commit's facts. */
export interface CommitContext {
  /** Bound only while a managed turn step can still stop its input. */
  readonly cancelBeforeTurn?: (cancel: { readonly hook: string; readonly reason?: string }) => void;
  readonly abortSignal: AbortSignal;
  readonly ctx: ContextContainer;
  /** The commit's records with their positions. */
  readonly written: readonly WrittenEvent[];
  /** The commit's events. */
  readonly facts: readonly SessionEvent[];
  /** The conversation, where the step holds it. */
  readonly history: readonly ModelMessage[] | undefined;
}

/** One reaction as the runner sees it. Every surface desugars to this. */
export type Reaction = ValueReaction | CommitReaction;

interface ReactionBase {
  readonly id: string;
  readonly kind: ReactionKind;
  /** Where it was authored, for errors and logs. */
  readonly label: string;
}

/** A dynamic value: a function of the session, evaluated in each step that needs it. */
export interface ValueReaction extends ReactionBase {
  readonly timing?: never;
  /** Runs the definition. Its memos keep what it learns from outside. */
  readonly evaluate: (ctx: InternalContext) => unknown;
  /** Validates and names the value. Throws on a value the kind can't read. */
  readonly contribute: (
    result: unknown,
    ctx: InternalContext,
  ) => Contribution | Promise<Contribution>;
}

/** A hook, or one of eve's own effects: it runs after every commit. */
export interface CommitReaction extends ReactionBase {
  readonly timing: "commit";
  readonly onCommit: (ctx: CommitContext) => Promise<void>;
}

/** The bundle's reactions in run order, and what each kind does once its slots change. */
export interface BundleReactions {
  readonly reactions: readonly Reaction[];
  readonly effects: Partial<Record<ReactionKind, (ctx: ContextContainer) => Promise<void>>>;
}

/**
 * An authored definition's function as a reaction's: it gets the public context. eve's own, which
 * `asFrameworkDefinition` marks, get eve's.
 */
export function authoredEvaluate(
  evaluate: DynamicEvaluateFn,
  options: { readonly framework?: boolean } = {},
): ValueReaction["evaluate"] {
  const fn = evaluate as (ctx: DynamicContext) => unknown;
  if (options.framework === true) return fn;
  return (ctx) => fn(publicContext(ctx));
}

/** The public part of an evaluation context. */
export function publicContext(ctx: InternalContext): DynamicContext {
  // Descriptors, not a spread: a spread would read getters such as `model`, which may throw.
  const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(ctx);
  delete descriptors.abortSignal;
  delete descriptors.ctx;
  delete descriptors.history;
  return Object.defineProperties({}, descriptors) as DynamicContext;
}

/** The conversation, or an error saying where it's available. */
export function requireHistory(
  ctx: Pick<InternalContext, "history"> | Pick<CommitContext, "history">,
  label: string,
): readonly ModelMessage[] {
  if (ctx.history !== undefined) return ctx.history;
  throw new Error(
    `"${label}" read the conversation where the step doesn't hold it: steps that settle background work between turns don't carry it. Read it in a turn, or keep what a turn read in a memo.`,
  );
}
