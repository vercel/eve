import type { ModelMessage } from "ai";

import type { SessionEvent } from "#protocol/session-event.js";

import { runOnSelection, type ContextContainer } from "#context/container.js";
import type { ReactionView, RecordContext, SelectContext } from "#dynamic/definition.js";
import type { WrittenEvent } from "#execution/publish-session-events.js";
import type { ReactionRenderFn } from "#runtime/types.js";
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

/** Thrown by `view.messages` where the step doesn't hold the conversation. */
export const CONVERSATION_UNAVAILABLE = Symbol("eve.reactions.conversation-unavailable");

/** What eve's own reactions receive: the session's identity and channel, and the step's state. */
export interface InternalRecordContext extends SelectContext {
  readonly abortSignal: AbortSignal;
  readonly ctx: ContextContainer;
  /** The commit's records with their positions, empty before a model call. */
  readonly written: readonly WrittenEvent[];
  /** The commit's events, for eve's own effects; authored `record` never sees them. */
  readonly facts: readonly SessionEvent[];
  /** The digest of the selection this occurrence is for. */
  readonly digest: string;
  /** How many selections the reaction has had: a new selection is a new occurrence. */
  readonly occurrence: number;
  /** The conversation, where the step holds it. */
  readonly history: readonly ModelMessage[] | undefined;
}

/**
 * The context a framework definition's `record` receives: eve passes its own context to the
 * definitions it marks with `asFrameworkDefinition`, where authored ones get the public part.
 */
export function frameworkRecordContext(ctx: unknown): InternalRecordContext {
  if (typeof ctx !== "object" || ctx === null || !("ctx" in ctx) || !("written" in ctx)) {
    throw new Error("A framework definition ran without eve's record context.");
  }
  return ctx as InternalRecordContext;
}

/** One reaction as the runner sees it. Every surface desugars to this. */
export interface Reaction {
  readonly id: string;
  readonly kind: ReactionKind;
  /** Where it was authored, for errors and logs. */
  readonly label: string;
  /**
   * When it runs: after every commit, as hooks do, or, by default, before each model call, as
   * dynamic values do.
   */
  readonly timing?: "commit";
  readonly select?: (view: ReactionView, ctx: SelectContext) => unknown;
  /** Fetches what the value is made of, once per new selection. Without it, that's the selection. */
  readonly record?: (selected: unknown, ctx: InternalRecordContext) => unknown;
  /**
   * Renders the value from what was recorded: `record`'s result, or the selection. A process that
   * didn't render it renders again from the recorded JSON; nothing records again for a selection
   * already recorded. Without it, what `record` returned is the value.
   */
  readonly render?: (input: JsonValue, ctx: InternalRecordContext) => unknown;
  /** Validates and names the value. Throws on a value the kind can't read. */
  readonly contribute: (
    result: unknown,
    ctx: InternalRecordContext,
  ) => Contribution | Promise<Contribution>;
}

/** The bundle's reactions in run order, and what each kind does once its slots change. */
export interface BundleReactions {
  readonly reactions: readonly Reaction[];
  readonly effects: Partial<Record<ReactionKind, (ctx: ContextContainer) => Promise<void>>>;
}

/**
 * An authored `record` as a reaction's: it runs outside the session's context and gets only the
 * public {@link RecordContext}, so only its selection is watched.
 */
export function authoredRecord(
  label: string,
  record: ((selected: never, ctx: never) => unknown) | undefined,
  options: { readonly framework?: boolean } = {},
): Reaction["record"] {
  if (record === undefined) return undefined;
  if (options.framework === true) return record as Reaction["record"];
  return (selected, ctx) =>
    runOnSelection(label, () =>
      record(selected as never, publicRecordContext(ctx, label) as never),
    );
}

/**
 * An authored `render` as a reaction's: synchronous, outside the session's context, and given only
 * what was recorded. eve's own renders, such as a memory slot's tools, run in context and may wait.
 */
export function authoredRender(
  label: string,
  render: ReactionRenderFn | undefined,
): ((input: JsonValue) => unknown) | undefined;
export function authoredRender(
  label: string,
  render: ReactionRenderFn | undefined,
  options: { readonly framework?: boolean },
): Reaction["render"];
export function authoredRender(
  label: string,
  render: ReactionRenderFn | undefined,
  options: { readonly framework?: boolean } = {},
): Reaction["render"] {
  if (render === undefined) return undefined;
  if (options.framework === true) return (input, ctx) => render(input as never, ctx as never);
  return (input) => {
    const rendered = runOnSelection(label, () => render(input as never));
    if (typeof (rendered as { then?: unknown } | null)?.then === "function") {
      throw new Error(
        `The render of "${label}" returned a promise. render is synchronous, so it can't do I/O: fetch in record, and render from what it returns.`,
      );
    }
    return rendered;
  };
}

/** The public part of a record context. `messages()` returns the conversation where the step holds it. */
export function publicRecordContext(ctx: InternalRecordContext, label: string): RecordContext {
  return {
    abortSignal: ctx.abortSignal,
    channel: ctx.channel,
    messages: async () => requireHistory(ctx, label),
    session: ctx.session,
    ...(ctx.conversation !== undefined && { conversation: ctx.conversation }),
  };
}

/** The conversation, or an error saying where it's available. */
export function requireHistory(
  ctx: Pick<InternalRecordContext, "history">,
  label: string,
): readonly ModelMessage[] {
  if (ctx.history !== undefined) return ctx.history;
  throw new Error(
    `"${label}" read the conversation where the step doesn't hold it: steps that settle background work between turns don't carry it. Read it in a turn, or from what a turn recorded.`,
  );
}
