import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { InputRequest } from "#runtime/input/types.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { EveEvalSubagentCall, EveEvalToolCall } from "#evals/types.js";

/**
 * One matcher accepted by the assertion options (`t.calledTool`,
 * `t.calledSubagent`):
 *
 * - a **literal** is compared structurally; objects partial-deep-match (every
 *   key in the matcher must match the observed value, recursively, and nested
 *   values are matchers themselves), arrays match element-wise, primitives
 *   compare with `Object.is`
 * - a **RegExp** tests string values directly and the JSON serialization of
 *   anything else
 * - a **function** receives the observed value and returns a boolean verdict
 */
export type EveEvalValueMatcher<T = JsonValue | undefined> = EveEvalDeepMatcher<T>;

/**
 * Constraint over an observed assertion count. A number requires an exact
 * count; a predicate receives the observed count and returns its verdict.
 */
export type EveEvalCountMatcher = number | ((count: number) => boolean);

type EveEvalDeepMatcher<T> =
  | RegExp
  | ((value: T) => boolean)
  | (T extends readonly (infer TEntry)[]
      ? readonly EveEvalDeepMatcher<TEntry>[]
      : T extends object
        ? { readonly [K in keyof T]?: EveEvalDeepMatcher<T[K]> }
        : T);

/**
 * Constraints applied to tool calls by `t.calledTool`. All provided
 * constraints must hold for a call to match.
 */
export interface EveEvalToolCallMatchOptions {
  /** Partial-deep matcher over the call input (see {@link EveEvalValueMatcher}). */
  readonly input?: EveEvalValueMatcher<JsonObject>;
  /** Matcher over the call output. */
  readonly output?: EveEvalValueMatcher;
  /** Required lifecycle outcome. Defaults to `"completed"`. */
  readonly status?: EveEvalToolCall["status"];
  /** Constraint over the matching call count. Defaults to "at least one". */
  readonly count?: EveEvalCountMatcher;
}

/**
 * Constraints applied to a `load_skill` call by `t.loadedSkill`. Identical to
 * {@link EveEvalToolCallMatchOptions} without `input`, which the helper fixes to
 * the loaded skill id.
 */
export type EveEvalSkillLoadMatchOptions = Omit<EveEvalToolCallMatchOptions, "input">;

/**
 * Constraints applied to subagent calls by `t.calledSubagent`.
 */
export interface EveEvalSubagentCallMatchOptions {
  /** Matcher over the runtime-action call id. */
  readonly callId?: EveEvalValueMatcher<string | undefined>;
  /** Matcher over the durable child session id, when delegation started. */
  readonly childSessionId?: EveEvalValueMatcher<string | undefined>;
  /** Matcher over the `subagent.called` remote URL. */
  readonly remoteUrl?: EveEvalValueMatcher<string | undefined>;
  /** Matcher over the `subagent.completed` output. */
  readonly output?: EveEvalValueMatcher;
  /** Required lifecycle outcome. Defaults to `"completed"`. */
  readonly status?: EveEvalSubagentCall["status"];
  /** Constraint over the matching delegation count. Defaults to "at least one". */
  readonly count?: EveEvalCountMatcher;
}

/** Constraints accepted by `requireInputRequest`. */
export interface EveEvalInputRequestMatchOptions {
  /** Matcher over the request's display hint. */
  readonly display?: EveEvalValueMatcher<InputRequest["display"]>;
  /** Partial-deep matcher over a tool-call action's input. */
  readonly input?: EveEvalValueMatcher<JsonObject>;
  /** Matcher over the complete option-id list in request order. */
  readonly optionIds?: EveEvalValueMatcher<readonly string[]>;
  /** Matcher over the request prompt. */
  readonly prompt?: EveEvalValueMatcher<string>;
  /** Required tool name for a tool-call action. */
  readonly toolName?: string;
}

/** One typed stream-event matcher used by scoped event assertions. */
export type EveEvalEventMatch<
  TType extends HandleMessageStreamEvent["type"] = HandleMessageStreamEvent["type"],
> = TType extends HandleMessageStreamEvent["type"]
  ? {
      /** Stream-event type to match. */
      readonly type: TType;
      /** Partial-deep matcher over the event data. */
      readonly data?: EveEvalDeepMatcher<
        Extract<HandleMessageStreamEvent, { type: TType }> extends { data: infer TData }
          ? TData
          : never
      >;
      /** Constraint over the matching event count. Defaults to "at least one". */
      readonly count?: EveEvalCountMatcher;
    }
  : never;

/**
 * Returns true when the observed value satisfies a matcher (literal, RegExp,
 * or function — see {@link EveEvalValueMatcher}).
 */
export function matchesValue(matcher: unknown, value: unknown): boolean {
  if (matcher instanceof RegExp) {
    return testRegExpAgainst(matcher, value);
  }

  if (typeof matcher === "function") {
    return (matcher as (value: unknown) => boolean)(value);
  }

  if (Array.isArray(matcher)) {
    if (!Array.isArray(value) || value.length !== matcher.length) return false;
    return matcher.every((entry, index) => matchesValue(entry, value[index]));
  }

  if (isPlainObject(matcher)) {
    if (!isPlainObject(value)) return false;
    return Object.entries(matcher).every(([key, entry]) => matchesValue(entry, value[key]));
  }

  return Object.is(matcher, value);
}

/**
 * Returns true when one derived tool call satisfies the `input`/`output`/
 * lifecycle constraints (the `count` option is the caller's concern).
 */
export function toolCallMatches(
  call: EveEvalToolCall,
  options: EveEvalToolCallMatchOptions,
): boolean {
  if (options.input !== undefined && !matchesValue(options.input, call.input)) return false;
  if (options.output !== undefined && !matchesValue(options.output, call.output)) {
    return false;
  }
  if (call.status !== (options.status ?? "completed")) return false;
  return true;
}

/**
 * Returns true when one derived subagent call satisfies the `remoteUrl`/
 * `output` constraints.
 */
export function subagentCallMatches(
  call: EveEvalSubagentCall,
  options: EveEvalSubagentCallMatchOptions,
): boolean {
  if (options.callId !== undefined && !matchesValue(options.callId, call.callId)) {
    return false;
  }
  if (
    options.childSessionId !== undefined &&
    !matchesValue(options.childSessionId, call.childSessionId)
  ) {
    return false;
  }
  if (options.remoteUrl !== undefined && !matchesValue(options.remoteUrl, call.remoteUrl)) {
    return false;
  }
  if (options.output !== undefined && !matchesValue(options.output, call.output)) {
    return false;
  }
  if (call.status !== (options.status ?? "completed")) return false;
  return true;
}

/** Returns true when one HITL request satisfies every supplied constraint. */
export function inputRequestMatches(
  request: InputRequest,
  options: EveEvalInputRequestMatchOptions,
): boolean {
  if (options.display !== undefined && !matchesValue(options.display, request.display))
    return false;
  if (options.prompt !== undefined && !matchesValue(options.prompt, request.prompt)) return false;
  if (options.optionIds !== undefined) {
    const optionIds = (request.options ?? []).map((option) => option.id);
    if (!matchesValue(options.optionIds, optionIds)) return false;
  }
  if (options.toolName !== undefined) {
    if (request.action.kind !== "tool-call" || request.action.toolName !== options.toolName) {
      return false;
    }
  }
  if (options.input !== undefined) {
    if (request.action.kind !== "tool-call" || !matchesValue(options.input, request.action.input)) {
      return false;
    }
  }
  return true;
}

/** Returns true when one stream event satisfies a typed event matcher. */
export function eventMatches(event: HandleMessageStreamEvent, matcher: EveEvalEventMatch): boolean {
  return (
    event.type === matcher.type &&
    (matcher.data === undefined ||
      matchesValue(matcher.data, "data" in event ? event.data : undefined))
  );
}

/**
 * Strict structural equality used by scoped `outputEquals`: unlike matcher
 * comparison, objects must carry exactly the same keys on both sides.
 */
export function deepEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => deepEquals(entry, b[index]));
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => deepEquals(a[key], b[key]));
  }

  return false;
}

function testRegExpAgainst(pattern: RegExp, value: unknown): boolean {
  if (typeof value === "string") return testRegExp(pattern, value);
  if (value === undefined) return false;
  const serialized = JSON.stringify(value);
  return serialized !== undefined && testRegExp(pattern, serialized);
}

/**
 * Tests a RegExp without carrying `lastIndex` state between calls. Matcher
 * patterns are reused across tool calls and across every case in an eval, so
 * a `g`/`y`-flagged pattern would otherwise return order-dependent results.
 */
export function testRegExp(pattern: RegExp, text: string): boolean {
  if (pattern.global || pattern.sticky) pattern.lastIndex = 0;
  return pattern.test(text);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
