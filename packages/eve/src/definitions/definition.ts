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
import type { HarnessModelMessage } from "#harness/messages.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";
import type { SessionView } from "#harness/session-machine/view.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

export type Lazy<T> = T | (() => T | Promise<T>);

export async function force<T>(value: Lazy<T> | undefined): Promise<T | undefined> {
  return typeof value === "function" ? await (value as () => T | Promise<T>)() : value;
}

export function once<T>(fn: () => T | Promise<T>): () => Promise<T> {
  let made: Promise<T> | undefined;
  return () => (made ??= Promise.resolve().then(fn));
}

export interface Definition {
  readonly id: string;
  readonly label: string;
  readonly contribute: (ctx: DefinitionContext) => Contribution;
  readonly install?: (ctx: ContextContainer) => Promise<void>;
}

export interface ContributionValues {
  readonly system: readonly Section[];
  readonly tools: ToolContribution;
  readonly context: readonly AnchoredEntry[];
  readonly announcements: Readonly<Record<string, Announcement>>;
  readonly effects: readonly Effect[];
  readonly model: ModelChoice | undefined;
  readonly compactionModel: ModelChoice | undefined;
}

export type Contribution = {
  readonly [F in keyof ContributionValues]?: Lazy<ContributionValues[F]>;
} & {
  readonly arrange?: (draft: Draft) => Partial<Draft>;
};

export interface Route {
  readonly inputSchema: JsonObject;
  target(input: unknown): RouteTarget | RouteMiss;
  explain?(entry: HarnessToolDefinition, issues: readonly RouteIssue[]): readonly RouteIssue[];
}

export interface RouteTarget {
  readonly name: string;
  readonly input: unknown;
  readonly at?: string;
}

export interface RouteMiss {
  readonly issue: string;
  readonly path: string;
}

export type RouteIssue = StandardSchemaV1.Issue;

export interface Draft {
  readonly system: () => Promise<readonly Section[]>;
  readonly tools: () => Promise<ToolTable>;
  readonly context: () => Promise<readonly AnchoredEntry[]>;
  readonly announcements: () => Promise<Readonly<Record<string, Announcement>>>;
}

export interface Kept {
  readonly value: JsonValue;
  readonly live?: unknown;
}

export type Evaluate = (
  ctx: InternalContext,
  previous: JsonValue | undefined,
) => Kept | null | Promise<Kept | null>;

export interface DefinitionContext {
  readonly container: ContextReader;
  readonly signal: AbortSignal;
  readonly history: readonly ModelMessage[] | undefined;
  readonly step?: StepInfo;
  readonly call?: CallInput;
  readonly commit?: CommitInput;
  keep(evaluate: Evaluate, options?: { readonly choosesModel?: true }): Promise<Kept | undefined>;
}

export interface StepInfo {
  readonly agentTools: HarnessToolMap;
  readonly endsTurn: boolean;
  readonly finalReplyOnly: boolean;
  readonly session: Pick<HarnessSession, "rootSessionId">;
  readonly view?: () => SessionView;
}

export interface CommitInput {
  readonly written: readonly WrittenEvent[];
  readonly cancelBeforeTurn?: (cancel: { readonly hook: string; readonly reason?: string }) => void;
}

export interface Effect {
  readonly id: string;
  readonly run: () => Promise<void>;
  readonly blocking?: true;
}

export interface CallInput {
  readonly skillCatalog?: ReadonlyMap<string, CatalogSkill>;
  readonly record: readonly HarnessModelMessage[];
  readonly currentInput: ReadonlySet<HarnessModelMessage>;
  readonly historyState: HistoryState;
}

export interface CallRecord {
  readonly record: readonly HarnessModelMessage[];
  readonly historyState: HistoryState;
}

export interface Section {
  readonly key: string;
  readonly text: string;
  readonly part: "base" | "own";
  readonly order: number;
}

export const SECTION_ORDER = {
  instructions: 10,
  workspace: 20,
  skills: 40,
  dynamicInstructions: 100,
  approvals: 300,
} as const;

export function section(
  key: string,
  text: string,
  options: { readonly order: number; readonly part?: Section["part"] },
): Section {
  return { key, order: options.order, part: options.part ?? "base", text };
}

export interface ToolEntry {
  readonly definition: HarnessToolDefinition;
  readonly source?: string;
  readonly route?: Route;
  readonly announcements?: Readonly<Record<string, Announcement>>;
}

export interface ToolTable {
  readonly entries: ReadonlyMap<string, ToolEntry>;
  readonly connections: readonly ResolvedConnectionDefinition[];
  readonly skills: ReadonlyMap<string, CatalogSkill>;
}

export type ToolContribution = Partial<ToolTable>;

export const EMPTY_TOOLS: ToolTable = { connections: [], entries: new Map(), skills: new Map() };

export interface AnchoredEntry {
  readonly turnId: string;
  readonly message: HarnessModelMessage;
}

export function renderSystem(sections: readonly Section[]): string | readonly string[] {
  const sorted = sections
    .map((section, index) => ({ index, section }))
    .sort((a, b) => a.section.order - b.section.order || a.index - b.index)
    .map(({ section }) => section);
  const base = sorted.filter((section) => section.part === "base");
  const own = sorted.filter((section) => section.part === "own").map((section) => section.text);
  const joined = base
    .map((section) => section.text)
    .filter((text) => text !== "")
    .join("\n\n");
  return own.length === 0 ? joined : [joined, ...own];
}

export interface InternalContext extends DynamicContext {
  readonly abortSignal: AbortSignal;
  readonly ctx: ContextContainer;
  readonly history: readonly ModelMessage[] | undefined;
}

export function authoredEvaluate(evaluate: unknown): (ctx: InternalContext) => unknown {
  const fn = evaluate as (ctx: DynamicContext) => unknown;
  return (ctx) => fn(publicContext(ctx));
}

export function publicContext(ctx: InternalContext): DynamicContext {
  const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(ctx);
  delete descriptors.abortSignal;
  delete descriptors.ctx;
  delete descriptors.history;
  return Object.defineProperties({}, descriptors) as DynamicContext;
}

export function requireHistory(
  history: readonly ModelMessage[] | undefined,
  label: string,
): readonly ModelMessage[] {
  if (history !== undefined) return history;
  throw new Error(
    `"${label}" read the conversation where the step doesn't hold it: steps that settle background work between turns don't carry it. Read it in a turn, or keep what a turn read in a memo.`,
  );
}

export function committed<T extends WrittenEvent["event"]["type"]>(
  ctx: Pick<DefinitionContext, "commit">,
  type: T,
): Extract<WrittenEvent["event"], { type: T }>[] {
  return (ctx.commit?.written ?? []).flatMap(({ event }) =>
    event.type === type ? [event as Extract<WrittenEvent["event"], { type: T }>] : [],
  );
}
