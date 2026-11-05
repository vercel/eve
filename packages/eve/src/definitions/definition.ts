import type { ModelMessage } from "ai";

import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import type { ContextContainer } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import type { HistoryState, LiveDynamicModelSelection as ModelChoice } from "#context/keys.js";
import type { DynamicContext } from "#dynamic/definition.js";
import type { CatalogSkill } from "#execution/catalog/skills.js";
import type { WrittenEvent } from "#execution/publish-session-events.js";
import type { Announcement } from "#harness/announcements.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { CodeSandbox } from "#runtime/sandbox/code-sandbox.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";
import type { SessionView } from "#harness/session-machine/view.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

// An agent is one function of its session. Each file it declares is a definition, eve's own
// features are definitions, and the agent is all of them together. A definition reads where eve
// is and says what it adds: parts of the system prompt, tools, context for the model call, what it
// announces, what to do about a commit, or the model. eve collects what every definition adds,
// lets each arrange the call in turn, and takes the latest choice of model.

/** A value, or a function eve calls only where it needs the value. */
export type Lazy<T> = T | (() => T | Promise<T>);

export async function force<T>(value: Lazy<T> | undefined): Promise<T | undefined> {
  return typeof value === "function" ? await (value as () => T | Promise<T>)() : value;
}

/** `fn`, run at most once. */
export function once<T>(fn: () => T | Promise<T>): () => Promise<T> {
  let made: Promise<T> | undefined;
  return () => (made ??= Promise.resolve().then(fn));
}

export interface Definition {
  /** Stable across deployments: what the definition keeps, and its memos, are under it. */
  readonly id: string;
  /** Names it in errors and logs: a file's path, or `eve.<feature>`. */
  readonly label: string;
  readonly contribute: (ctx: DefinitionContext) => Contribution;
  /**
   * Applies what its kind's definitions keep to the step's process or sandbox, such as the
   * connection registry or skill files: as a step starts, and after what it keeps changes. Every
   * definition of a kind names the same function, which reads the kind's kept values with
   * `slotsOf`, and runs once per step start.
   */
  readonly install?: (ctx: ContextContainer) => Promise<void>;
  /**
   * Session resources the definition's contributions need, for an agent defined in code: a file
   * agent's come from its compiled node.
   */
  readonly resources?: DefinitionResources;
}

/** Session resources a code agent's definitions provide. */
export interface DefinitionResources {
  /**
   * The sandbox the session opens, which `ctx.getSandbox()` and the bash and file tools use. The
   * first definition that names one provides it.
   */
  readonly sandbox?: CodeSandbox;
}

/** What a definition can add, by field. */
export interface ContributionValues {
  /** Collected: parts of the system prompt, which sort by their `order`. */
  readonly system: readonly Section[];
  /** Collected: what the model can reach. The first definition to offer a name keeps it. */
  readonly tools: ToolContribution;
  /** Collected: context for this call only, each entry ahead of its turn's input. */
  readonly context: readonly AnchoredEntry[];
  /** Collected: what the model is told once, and again each time it changes, by key. */
  readonly announcements: Readonly<Record<string, Announcement>>;
  /** Collected: what to do about the commit, after it. */
  readonly effects: readonly Effect[];
  /** Decided: the model the call runs. The latest definition that answers chooses it. */
  readonly model: ModelChoice | undefined;
}

/** What a definition adds. Every field is optional, and read only where eve needs it. */
export type Contribution = {
  readonly [F in keyof ContributionValues]?: Lazy<ContributionValues[F]>;
} & {
  /** Arranged: after collecting, in order, the parts of the call it replaces. */
  readonly arrange?: (draft: Draft) => Partial<Draft>;
};

/**
 * What makes a tool a route: its call becomes the call to the entry it names, which every gate
 * then sees as that entry's own. Only an entry the step can run is reachable, not another route;
 * the model's history names the route.
 */
export interface Route {
  /** The route's own input, which reaches the entry's. */
  readonly inputSchema: JsonObject;
  /** The entry the route's input reaches, or what the model should fix. */
  target(input: unknown): RouteTarget | RouteMiss;
  /** What the model reads when the entry's own schema rejects its input. */
  explain?(entry: HarnessToolDefinition, issues: readonly RouteIssue[]): readonly RouteIssue[];
}

export interface RouteTarget {
  readonly name: string;
  readonly input: unknown;
  /** Where the entry's input sits in the route's, which issues with it report under. */
  readonly at?: string;
}

export interface RouteMiss {
  readonly issue: string;
  /** The route input's field at fault. */
  readonly path: string;
}

export type RouteIssue = StandardSchemaV1.Issue;

/** The model call as definitions make it, each part made when it's first read. */
export interface Draft {
  readonly system: () => Promise<readonly Section[]>;
  readonly tools: () => Promise<ToolTable>;
  readonly context: () => Promise<readonly AnchoredEntry[]>;
  readonly announcements: () => Promise<Readonly<Record<string, Announcement>>>;
}

/** What a definition keeps: its JSON form, which the session holds, and code that form can't carry. */
export interface Kept {
  readonly value: JsonValue;
  readonly live?: unknown;
}

/**
 * Makes what a definition keeps. `previous` is what it kept before. Its memos keep what it learns
 * from outside, so evaluating it again asks nothing of the outside world.
 */
export type Evaluate = (
  ctx: InternalContext,
  previous: JsonValue | undefined,
) => Kept | null | Promise<Kept | null>;

/** Where eve asks a definition what it adds. */
export interface DefinitionContext {
  /** The session's context: its bundle, state, and registries. */
  readonly container: ContextReader;
  readonly signal: AbortSignal;
  /** The conversation, where the step holds it. */
  readonly history: readonly ModelMessage[] | undefined;
  /** Where a step asks. */
  readonly step?: StepInfo;
  /** Where a step makes a model call. */
  readonly call?: CallInput;
  /** After a commit. */
  readonly commit?: CommitInput;
  /**
   * What the definition keeps in the session. Before each model call eve evaluates it, once; the
   * call, and everything that follows from it, reads what that evaluation kept. A process that
   * lacks its code evaluates it again with its memos. `undefined` until it was first evaluated.
   */
  keep(evaluate: Evaluate, options?: { readonly choosesModel?: true }): Promise<Kept | undefined>;
}

export interface StepInfo {
  /** The agent's `defineTool()` tools, as the step runs them. */
  readonly agentTools: HarnessToolMap;
  /** A tool's `endsTurn` applies: a root turn without an output schema. */
  readonly endsTurn: boolean;
  /** The session's reader sees only its final reply: a child's caller or a schedule. */
  readonly finalReplyOnly: boolean;
  readonly session: Pick<HarnessSession, "rootSessionId">;
  /** The session as the step sees it, where a step runs. */
  readonly view?: () => SessionView;
}

export interface CommitInput {
  /** The commit's records with their positions. */
  readonly written: readonly WrittenEvent[];
  /** Bound only while a managed turn step can still stop its input. */
  readonly cancelBeforeTurn?: (cancel: { readonly hook: string; readonly reason?: string }) => void;
}

/** Something to do about a commit: eve runs it after the commit, at least once. */
export interface Effect {
  /** Names it among the session's commands and failures. */
  readonly id: string;
  readonly run: () => Promise<void>;
  /**
   * The operation the commit opened waits for it: when it throws, the operation fails before it
   * goes further. Otherwise a failure during a turn fails the turn.
   */
  readonly blocking?: true;
}

/** What the kernel knows where it asks for the call's messages. */
export interface CallInput {
  /** Durable history, with the turn's input. */
  readonly record: readonly HarnessModelMessage[];
  /** The turn's input among the record's messages: what eve adds for the turn goes before it. */
  readonly currentInput: ReadonlySet<HarnessModelMessage>;
  readonly historyState: HistoryState;
}

export interface CallRecord {
  readonly record: readonly HarnessModelMessage[];
  /** What eve last announced, which the record now reflects. */
  readonly historyState: HistoryState;
}

/**
 * One part of the system prompt. `base` sections join, in `order`, into the prompt's first part,
 * which stays the same across a session's calls; each `own` section is a part of its own after it.
 */
export interface Section {
  /** Who added it: a definition's path, or `eve.<feature>`. */
  readonly key: string;
  readonly text: string;
  readonly part: "base" | "own";
  /** Where it sits among the sections of its part; ties keep the order definitions added them. */
  readonly order: number;
}

/** Canonical places in eve's default prompt, so what files add doesn't depend on load order. */
export const SECTION_ORDER = {
  instructions: 10,
  workspace: 20,
  skills: 40,
  dynamicInstructions: 100,
  tasks: 200,
  approvals: 300,
} as const;

export function section(
  key: string,
  text: string,
  options: { readonly order: number; readonly part?: Section["part"] },
): Section {
  return { key, order: options.order, part: options.part ?? "base", text };
}

/** A tool the model can call: one that runs, or a route to one. */
export interface ToolEntry {
  /** For a route, what the model sees: its name, description, and input schema. */
  readonly definition: HarnessToolDefinition;
  /** The definition that added it, for errors. */
  readonly source?: string;
  /** Its calls become calls to the entry its input names. */
  readonly route?: Route;
  /** What the model is told about it while the call offers it, by key. */
  readonly announcements?: Readonly<Record<string, Announcement>>;
}

/** Everything a model call can reach: tools by name, connections, and skills. */
export interface ToolTable {
  readonly entries: ReadonlyMap<string, ToolEntry>;
  readonly connections: readonly ResolvedConnectionDefinition[];
  readonly skills: ReadonlyMap<string, CatalogSkill>;
}

export type ToolContribution = Partial<ToolTable>;

export const EMPTY_TOOLS: ToolTable = { connections: [], entries: new Map(), skills: new Map() };

/** Context for one call only, ahead of the input its turn brought. */
export interface AnchoredEntry {
  readonly turnId: string;
  readonly message: HarnessModelMessage;
}

/**
 * The system prompt the sections make: the `base` sections joined, then each `own` section. With
 * no `own` section, the base alone, as a string; with no `base` section, the `own` parts alone.
 */
export function renderSystem(sections: readonly Section[]): string | readonly string[] {
  const sorted = sections
    .map((section, index) => ({ index, section }))
    .sort((a, b) => a.section.order - b.section.order || a.index - b.index)
    .map(({ section }) => section);
  const base = sorted.filter((section) => section.part === "base");
  const own = sorted.filter((section) => section.part === "own").map((section) => section.text);
  if (base.length === 0) return own;
  const joined = base
    .map((section) => section.text)
    .filter((text) => text !== "")
    .join("\n\n");
  return own.length === 0 ? joined : [joined, ...own];
}

/**
 * What a definition's evaluation reads: the public context, and the step's state. Authored
 * definitions receive only the public part.
 */
export interface InternalContext extends DynamicContext {
  readonly abortSignal: AbortSignal;
  readonly ctx: ContextContainer;
  /** The conversation, where the step holds it. */
  readonly history: readonly ModelMessage[] | undefined;
}

/** An authored definition's function as an evaluation's: it gets the public context. */
export function authoredEvaluate(evaluate: unknown): (ctx: InternalContext) => unknown {
  const fn = evaluate as (ctx: DynamicContext) => unknown;
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
  history: readonly ModelMessage[] | undefined,
  label: string,
): readonly ModelMessage[] {
  if (history !== undefined) return history;
  throw new Error(
    `"${label}" read the conversation where the step doesn't hold it: steps that settle background work between turns don't carry it. Read it in a turn, or keep what a turn read in a memo.`,
  );
}

/** The commit's records of `type`, with the facts their type says. */
export function committed<T extends WrittenEvent["event"]["type"]>(
  ctx: Pick<DefinitionContext, "commit">,
  type: T,
): Extract<WrittenEvent["event"], { type: T }>[] {
  return (ctx.commit?.written ?? []).flatMap(({ event }) =>
    event.type === type ? [event as Extract<WrittenEvent["event"], { type: T }>] : [],
  );
}
