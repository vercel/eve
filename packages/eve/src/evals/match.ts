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
 * - a **function** receives the observed value and either returns a boolean
 *   verdict, or returns a resolved expected value that is then compared like a
 *   literal — e.g. `(o) => o === process.env.EVE_WEATHER_AGENT_HOST`. To assert
 *   a literal boolean field, use the literal directly; boolean returns are
 *   always treated as verdicts.
 */
export type EveEvalValueMatcher<T = unknown> = T | RegExp | ((value: T) => unknown);

/**
 * Constraints applied to tool calls by `t.calledTool`. All provided
 * constraints must hold for a call to match.
 */
export interface EveEvalToolCallMatchOptions {
  /** Partial-deep matcher over the call input (see {@link EveEvalValueMatcher}). */
  readonly input?: EveEvalValueMatcher;
  /** Matcher over the call output. */
  readonly output?: EveEvalValueMatcher;
  /** Required error state of matching calls. */
  readonly isError?: boolean;
  /** Exact number of matching calls required. Defaults to "at least one". */
  readonly times?: number;
}

/**
 * Constraints applied to subagent calls by `t.calledSubagent`.
 */
export interface EveEvalSubagentCallMatchOptions {
  /** Matcher over the `subagent.called` remote URL. */
  readonly remoteUrl?: EveEvalValueMatcher;
  /** Matcher over the `subagent.completed` output. */
  readonly output?: EveEvalValueMatcher;
}

/**
 * Returns true when the observed value satisfies a matcher (literal, RegExp,
 * or function — see {@link EveEvalValueMatcher}).
 */
export function matchesValue(matcher: unknown, value: unknown): boolean {
  if (matcher instanceof RegExp) {
    return testRegExpAgainst(matcher, value);
  }

  if (typeof matcher === "function") {
    const outcome = (matcher as (value: unknown) => unknown)(value);
    if (typeof outcome === "boolean") return outcome;
    // A resolver returned an expected value; functions compare by identity to
    // keep resolved values from recursing forever.
    if (typeof outcome === "function") return Object.is(outcome, value);
    return matchesValue(outcome, value);
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
 * `isError` constraints (the `times` count is the caller's concern).
 */
export function toolCallMatches(
  call: EveEvalToolCall,
  options: EveEvalToolCallMatchOptions,
): boolean {
  if (options.input !== undefined && !matchesValue(options.input, call.input)) return false;
  if (options.output !== undefined && !matchesValue(options.output, call.output)) {
    return false;
  }
  if (options.isError !== undefined && call.isError !== options.isError) return false;
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
  if (options.remoteUrl !== undefined && !matchesValue(options.remoteUrl, call.remoteUrl)) {
    return false;
  }
  if (options.output !== undefined && !matchesValue(options.output, call.output)) {
    return false;
  }
  return true;
}

/**
 * Strict structural equality used by `t.outputEquals`: unlike matcher
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
