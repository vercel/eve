import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import {
  deepEquals,
  eventMatches,
  subagentCallMatches,
  testRegExp,
  toolCallMatches,
  type EveEvalCountMatcher,
  type EveEvalSkillLoadMatchOptions,
  type EveEvalSubagentCallMatchOptions,
  type EveEvalToolCallMatchOptions,
} from "#evals/match.js";
import type { EveEvalEventMatch } from "#evals/match.js";
import { LOAD_SKILL_TOOL_NAME } from "#runtime/skills/fragment-context.js";
import type { AssertionOutcome, RunAssertion } from "#evals/assertions/collector.js";

/** Minimal captured scope consumed by deterministic eval assertions. */
export interface EveEvalAssertionSubject {
  readonly derived: import("#evals/types.js").EveEvalDerivedFacts;
  readonly events: readonly HandleMessageStreamEvent[];
  readonly output: unknown;
  readonly status: "completed" | "failed" | "waiting";
}

const PASS: AssertionOutcome = { score: 1 };
const fail = (message: string, metadata?: Readonly<Record<string, unknown>>): AssertionOutcome => ({
  score: 0,
  message,
  metadata,
});

/**
 * Asserts the run finished successfully: it did not fail and did not park on an
 * unanswered HITL input request.
 */
export function succeeded(): RunAssertion {
  return {
    name: "succeeded",
    evaluate(result) {
      const failure = runFailure(result);
      if (failure !== undefined) return failure;
      if (result.derived.parked) {
        return fail(
          `run parked on ${result.derived.inputRequests.length} unanswered input request(s)`,
        );
      }
      return PASS;
    },
  };
}

/**
 * Asserts the run ended cleanly parked on HITL input.
 */
export function parked(): RunAssertion {
  return {
    name: "parked",
    evaluate(result) {
      const failure = runFailure(result);
      if (failure !== undefined) return failure;
      if (result.derived.parked) return PASS;
      return fail(
        `expected the run to park on HITL input; it ended "${result.status}" with no pending requests`,
      );
    },
  };
}

/**
 * Asserts the joined assistant message text contains `token` (substring for
 * strings, `test` for RegExps).
 */
export function messageIncludes(token: string | RegExp): RunAssertion {
  return {
    name: `messageIncludes(${String(token)})`,
    evaluate(result) {
      const text = joinCompletedMessages(result.events);
      const passed = typeof token === "string" ? text.includes(token) : testRegExp(token, text);
      if (passed) return PASS;
      return fail(`assistant messages did not include ${String(token)}; got: ${truncate(text)}`);
    },
  };
}

/**
 * Asserts a completed tool call with `name` happened. Options constrain the
 * call further: `input` partial-deep-matches, `output` matches the result,
 * `status` overrides the lifecycle state, and `count` constrains the number of
 * matches with either an exact number or a predicate.
 */
export function calledTool(name: string, options: EveEvalToolCallMatchOptions = {}): RunAssertion {
  validateCount(options.count);
  return {
    name: `calledTool(${name})`,
    evaluate(result) {
      const named = result.derived.toolCalls.filter((call) => call.name === name);
      const matching = named.filter((call) => toolCallMatches(call, options));
      const passed = matchesCount(options.count, matching.length);
      if (passed) return { score: 1, metadata: { matchingCalls: matching.length } };

      const observed =
        named.length > 0
          ? `observed ${name} calls: ${named.map((call) => truncate(JSON.stringify(call.input))).join(", ")}`
          : `observed tools: [${result.derived.toolCalls.map((call) => call.name).join(", ")}]`;
      let expectation: string;
      if (options.count === undefined) {
        expectation = `expected a matching call to "${name}"`;
      } else if (typeof options.count === "number") {
        expectation = `expected exactly ${options.count} matching call(s), found ${matching.length}`;
      } else {
        expectation = `expected matching call count to satisfy the count predicate, found ${matching.length}`;
      }
      return fail(`${expectation}; ${observed}`);
    },
  };
}

/**
 * Sugar over {@link calledTool} for the framework `load_skill` tool: asserts a
 * skill with id `skill` was loaded. `output`/`status`/`count` constrain the
 * matching call exactly as for `calledTool`.
 */
export function loadedSkill(
  skill: string,
  options: EveEvalSkillLoadMatchOptions = {},
): RunAssertion {
  const base = calledTool(LOAD_SKILL_TOOL_NAME, { ...options, input: { skill } });
  return { ...base, name: `loadedSkill(${skill})` };
}

/**
 * Asserts no tool call with `name` happened.
 */
export function notCalledTool(name: string): RunAssertion {
  return {
    name: `notCalledTool(${name})`,
    evaluate(result) {
      const count = result.derived.toolCalls.filter((call) => call.name === name).length;
      if (count === 0) return PASS;
      return fail(`"${name}" was called ${count} time(s)`);
    },
  };
}

/**
 * Asserts the named tools were requested in the given order (subsequence match:
 * other calls may interleave).
 */
export function toolOrder(names: readonly string[]): RunAssertion {
  return {
    name: `toolOrder(${names.join(" → ")})`,
    evaluate(result) {
      const requested = requestedTools(result.events);
      const observed = requested.map((entry) => entry.name);
      const missing = missingOrderedName(names, observed);
      if (missing !== undefined) {
        return fail(
          `missing "${missing.name}" after [${names.slice(0, missing.cursor).join(", ")}]; observed request order: [${observed.join(", ")}]`,
        );
      }
      return PASS;
    },
  };
}

/**
 * Asserts the run made no tool calls at all.
 */
export function usedNoTools(): RunAssertion {
  return {
    name: "usedNoTools",
    evaluate(result) {
      const count = result.derived.toolCallCount;
      if (count === 0) return PASS;
      return fail(`expected no tool calls, got ${count}`, { toolCallCount: count });
    },
  };
}

/**
 * Asserts the run made at most `max` tool calls.
 */
export function maxToolCalls(max: number): RunAssertion {
  validateCount(max);
  return {
    name: `maxToolCalls(${max})`,
    evaluate(result) {
      const count = result.derived.toolCallCount;
      if (count <= max) return PASS;
      return fail(`expected at most ${max} tool calls, got ${count}`, {
        maxAllowed: max,
        toolCallCount: count,
      });
    },
  };
}

/**
 * Asserts no action result (tool, subagent, or skill) reported a failure.
 */
export function noFailedActions(): RunAssertion {
  return {
    name: "noFailedActions",
    evaluate(result) {
      const failed = result.events.filter(
        (evt): evt is Extract<HandleMessageStreamEvent, { type: "action.result" }> =>
          evt.type === "action.result" &&
          (evt.data.status === "failed" || evt.data.result.isError === true),
      );
      if (failed.length === 0) return PASS;
      const details = failed.map(formatFailedActionResult);
      return fail(`${failed.length} failed action(s): ${details.join("; ")}`, {
        failedActions: failed.map((evt) => ({
          callId: evt.data.result.callId,
          error: evt.data.error,
          kind: evt.data.result.kind,
          output: evt.data.result.output,
          status: evt.data.status,
        })),
      });
    },
  };
}

/**
 * Asserts a subagent delegation to `name` occurred. Identity and remote
 * metadata come from `subagent.called`; `output` comes from
 * `subagent.completed`.
 */
export function calledSubagent(
  name: string,
  options: EveEvalSubagentCallMatchOptions = {},
): RunAssertion {
  validateCount(options.count);
  return {
    name: `calledSubagent(${name})`,
    evaluate(result) {
      const named = result.derived.subagentCalls.filter((call) => call.name === name);
      const matching = named.filter((call) => subagentCallMatches(call, options));
      const passed = matchesCount(options.count, matching.length);
      if (passed) return { score: 1, metadata: { matchingCalls: matching.length } };

      if (named.length === 0) {
        const observed = result.derived.subagentCalls.map((call) => call.name);
        return fail(`subagent "${name}" was never called; observed: [${observed.join(", ")}]`, {
          observedSubagentCalls: result.derived.subagentCalls,
        });
      }
      return fail(
        `subagent "${name}" was called but ${matching.length} call(s) matched the constraints`,
        {
          observedSubagentCalls: named,
        },
      );
    },
  };
}

/**
 * Escape hatch: asserts an arbitrary predicate over the full typed event
 * stream. `label` names the assertion in reports.
 */
export function eventsSatisfy(
  label: string,
  predicate: (events: readonly HandleMessageStreamEvent[]) => boolean,
): RunAssertion {
  return {
    name: `eventsSatisfy(${label})`,
    evaluate(result) {
      if (predicate(result.events)) return PASS;
      return fail(`event predicate "${label}" did not hold`);
    },
  };
}

/** Asserts a typed stream event exists, optionally constraining its count. */
export function typedEvent(matcher: EveEvalEventMatch): RunAssertion {
  validateCount(matcher.count);
  return {
    name: `event(${matcher.type})`,
    evaluate(result) {
      const matching = result.events.filter((entry) => eventMatches(entry, matcher));
      const passed = matchesCount(matcher.count, matching.length);
      if (passed) return { score: 1, metadata: { matchingEvents: matching.length } };
      const expected = describeCount(matcher.count);
      return fail(
        `expected ${expected} matching ${matcher.type} event(s), found ${matching.length}; observed: [${result.events.map((entry) => entry.type).join(", ")}]`,
      );
    },
  };
}

/** Asserts no typed stream event matches. */
export function notEvent(matcher: EveEvalEventMatch): RunAssertion {
  return {
    name: `notEvent(${matcher.type})`,
    evaluate(result) {
      const matching = result.events.filter((entry) => eventMatches(entry, matcher));
      return matching.length === 0
        ? PASS
        : fail(`expected no matching ${matcher.type} events, found ${matching.length}`);
    },
  };
}

/** Asserts typed event groups occur in order, ignoring unrelated events. */
export function eventOrder(matchers: readonly EveEvalEventMatch[]): RunAssertion {
  for (const matcher of matchers) validateCount(matcher.count);
  return {
    name: `eventOrder(${matchers.map((matcher) => matcher.type).join(" → ")})`,
    evaluate(result) {
      let previousLast = -1;
      for (const matcher of matchers) {
        const indexes = result.events.flatMap((entry, index) =>
          eventMatches(entry, matcher) ? [index] : [],
        );
        const countPassed = matchesCount(matcher.count, indexes.length);
        if (!countPassed) {
          const expected = describeCount(matcher.count);
          return fail(
            `expected ${expected} matching ${matcher.type} event(s), found ${indexes.length}`,
          );
        }
        const first = indexes[0];
        if (first === undefined || first <= previousLast) {
          return fail(`event group ${matcher.type} did not occur after the previous group`);
        }
        previousLast = indexes[indexes.length - 1] ?? previousLast;
      }
      return PASS;
    },
  };
}

/**
 * Asserts `result.output` (the final assistant message) deep-equals `value`.
 */
export function outputEquals(value: unknown): RunAssertion {
  return {
    name: "outputEquals",
    evaluate(result) {
      if (deepEquals(result.output, value)) return PASS;
      return fail(
        `output ${truncate(JSON.stringify(result.output))} does not equal expected ${truncate(JSON.stringify(value))}`,
      );
    },
  };
}

/**
 * Asserts `result.output` validates against a Standard Schema (e.g. a Zod
 * schema).
 */
export function outputMatches(schema: StandardSchemaV1): RunAssertion {
  return {
    name: "outputMatches",
    async evaluate(result) {
      const outcome = await schema["~standard"].validate(result.output);
      if (!("issues" in outcome) || outcome.issues === undefined) return PASS;
      const issues = outcome.issues.map((issue) => issue.message).join("; ");
      return fail(`output failed schema validation: ${issues}`);
    },
  };
}

function joinCompletedMessages(events: readonly HandleMessageStreamEvent[]): string {
  const parts: string[] = [];
  for (const evt of events) {
    if (evt.type === "message.completed" && evt.data.message !== null) {
      parts.push(evt.data.message);
    }
  }
  return parts.join("\n");
}

function failureDetail(prefix: string, code: string | undefined): string {
  return code === undefined ? prefix : `${prefix} (code: ${code})`;
}

function formatFailedActionResult(
  event: Extract<HandleMessageStreamEvent, { type: "action.result" }>,
): string {
  const { result, status } = event.data;
  const parts = [
    actionResultLabel(result),
    `callId=${result.callId}`,
    `status=${status}`,
    result.isError === true ? "isError=true" : undefined,
    event.data.error?.message === undefined ? undefined : `error=${event.data.error.message}`,
    `output=${truncate(formatUnknown(result.output))}`,
  ];
  return parts.filter((part) => part !== undefined).join(" ");
}

function actionResultLabel(
  result: Extract<HandleMessageStreamEvent, { type: "action.result" }>["data"]["result"],
): string {
  switch (result.kind) {
    case "tool-result":
      return `tool-result:${result.toolName}`;
    case "subagent-result":
      return `subagent-result:${result.subagentName}`;
    case "load-skill-result":
      return result.name === undefined ? "load-skill-result" : `load-skill-result:${result.name}`;
  }
}

function runFailure(result: EveEvalAssertionSubject): AssertionOutcome | undefined {
  if (result.status === "failed") {
    return fail(failureDetail("run failed", result.derived.failureCode));
  }
  const failedEvent = result.events.find(
    (event): event is Extract<HandleMessageStreamEvent, { type: "step.failed" | "turn.failed" }> =>
      event.type === "turn.failed" || event.type === "step.failed",
  );
  return failedEvent === undefined
    ? undefined
    : fail(`${failedEvent.type} (${failedEvent.data.code}): ${failedEvent.data.message}`);
}

function truncate(text: string | undefined, max = 200): string {
  if (text === undefined) return "undefined";
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function formatUnknown(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function matchesCount(matcher: EveEvalCountMatcher | undefined, count: number): boolean {
  if (matcher === undefined) return count > 0;
  return typeof matcher === "function" ? matcher(count) : count === matcher;
}

function describeCount(matcher: EveEvalCountMatcher | undefined): string {
  if (matcher === undefined) return "at least one";
  return typeof matcher === "function" ? "a count satisfying the predicate" : `exactly ${matcher}`;
}

function validateCount(count: unknown): void {
  if (count === undefined || typeof count === "function") return;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    throw new TypeError(
      `Assertion count must be a non-negative integer or predicate; received ${String(count)}.`,
    );
  }
}

function missingOrderedName(
  expected: readonly string[],
  observed: readonly string[],
): { readonly cursor: number; readonly name: string } | undefined {
  let cursor = 0;
  for (const name of observed) {
    if (name === expected[cursor]) cursor += 1;
    if (cursor === expected.length) return undefined;
  }
  const name = expected[cursor];
  return name === undefined ? undefined : { cursor, name };
}

interface ToolRequestEntry {
  readonly callId: string;
  readonly name: string;
}

function requestedTools(events: readonly HandleMessageStreamEvent[]): readonly ToolRequestEntry[] {
  const entries: ToolRequestEntry[] = [];
  const seenCallIds = new Set<string>();
  const append = (callId: string, name: string): void => {
    if (seenCallIds.has(callId)) return;
    seenCallIds.add(callId);
    entries.push({ callId, name });
  };

  for (const event of events) {
    if (event.type === "actions.requested") {
      for (const action of event.data.actions) {
        if (action.kind === "tool-call") append(action.callId, action.toolName);
      }
    } else if (event.type === "input.requested") {
      for (const request of event.data.requests) {
        const { action } = request;
        if (action.kind === "tool-call") append(action.callId, action.toolName);
      }
    }
  }
  return entries;
}
