import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import {
  deepEquals,
  subagentCallMatches,
  testRegExp,
  toolCallMatches,
  type EveEvalSubagentCallMatchOptions,
  type EveEvalToolCallMatchOptions,
} from "#evals/match.js";
import type { AssertionOutcome, RunAssertion } from "#evals/assertions/collector.js";

const PASS: AssertionOutcome = { score: 1 };
const fail = (message: string, metadata?: Readonly<Record<string, unknown>>): AssertionOutcome => ({
  score: 0,
  message,
  metadata,
});

/**
 * Asserts the run ran to completion: it did not fail and did not park on an
 * unanswered HITL input request.
 */
export function completed(): RunAssertion {
  return {
    name: "completed",
    evaluate(result) {
      if (result.status === "failed") {
        return fail(failureDetail("run failed", result.derived.failureCode));
      }
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
 * Asserts the run ended parked on HITL input. For approval gates and
 * ask-question flows.
 */
export function waiting(): RunAssertion {
  return {
    name: "waiting",
    evaluate(result) {
      if (result.derived.parked) return PASS;
      return fail(
        `expected the run to park on HITL input; it ended "${result.status}" with no pending requests`,
      );
    },
  };
}

/**
 * Asserts the run did not fail: terminal status is not `"failed"` and no
 * `turn.failed` / `step.failed` events were emitted. Parked runs pass; use
 * {@link completed} to also reject parking.
 */
export function didNotFail(): RunAssertion {
  return {
    name: "didNotFail",
    evaluate(result) {
      if (result.status === "failed") {
        return fail(failureDetail("run failed", result.derived.failureCode));
      }
      const failedEvent = result.events.find(
        (
          event,
        ): event is Extract<HandleMessageStreamEvent, { type: "step.failed" | "turn.failed" }> =>
          event.type === "turn.failed" || event.type === "step.failed",
      );
      if (failedEvent !== undefined) {
        return fail(`${failedEvent.type} (${failedEvent.data.code}): ${failedEvent.data.message}`);
      }
      return PASS;
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
 * Asserts a tool call with `name` happened. Options constrain the call
 * further: `input` partial-deep-matches, `output` matches the result,
 * `isError` constrains error state, and `times` requires an exact count.
 */
export function calledTool(name: string, options: EveEvalToolCallMatchOptions = {}): RunAssertion {
  return {
    name: `calledTool(${name})`,
    evaluate(result) {
      const named = result.derived.toolCalls.filter((call) => call.name === name);
      const matching = named.filter((call) => toolCallMatches(call, options));
      const passed =
        options.times !== undefined ? matching.length === options.times : matching.length > 0;
      if (passed) return { score: 1, metadata: { matchingCalls: matching.length } };

      const observed =
        named.length > 0
          ? `observed ${name} calls: ${named.map((call) => truncate(JSON.stringify(call.input))).join(", ")}`
          : `observed tools: [${result.derived.toolCalls.map((call) => call.name).join(", ")}]`;
      const expectation =
        options.times !== undefined
          ? `expected exactly ${options.times} matching call(s), found ${matching.length}`
          : `expected a matching call to "${name}"`;
      return fail(`${expectation}; ${observed}`);
    },
  };
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
 * Asserts the named tools were called in the given order (subsequence match:
 * other calls may interleave).
 */
export function toolOrder(names: readonly string[]): RunAssertion {
  return {
    name: `toolOrder(${names.join(" → ")})`,
    evaluate(result) {
      const observed = result.derived.toolCalls.map((call) => call.name);
      let cursor = 0;
      for (const name of observed) {
        if (name === names[cursor]) cursor += 1;
        if (cursor === names.length) break;
      }
      if (cursor === names.length) return PASS;
      return fail(
        `missing "${names[cursor]}" after [${names.slice(0, cursor).join(", ")}]; observed order: [${observed.join(", ")}]`,
      );
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
      const names = failed.map((evt) =>
        evt.data.result.kind === "tool-result" ? evt.data.result.toolName : evt.data.result.kind,
      );
      return fail(`${failed.length} failed action(s): ${names.join(", ")}`);
    },
  };
}

/**
 * Asserts a subagent delegation to `name` occurred. `remoteUrl` matches the
 * `subagent.called` remote metadata, `output` matches the `subagent.completed`
 * output.
 */
export function calledSubagent(
  name: string,
  options: EveEvalSubagentCallMatchOptions = {},
): RunAssertion {
  return {
    name: `calledSubagent(${name})`,
    evaluate(result) {
      const named = result.derived.subagentCalls.filter((call) => call.name === name);
      const matching = named.filter((call) => subagentCallMatches(call, options));
      if (matching.length > 0) return PASS;

      if (named.length === 0) {
        const observed = result.derived.subagentCalls.map((call) => call.name);
        return fail(`subagent "${name}" was never called; observed: [${observed.join(", ")}]`, {
          observedSubagentCalls: result.derived.subagentCalls,
        });
      }
      return fail(`subagent "${name}" was called but no call matched the constraints`, {
        observedSubagentCalls: named,
      });
    },
  };
}

/**
 * Escape hatch: asserts an arbitrary predicate over the full typed event
 * stream. `label` names the assertion in reports.
 */
export function event(
  predicate: (events: readonly HandleMessageStreamEvent[]) => boolean,
  label: string,
): RunAssertion {
  return {
    name: `event(${label})`,
    evaluate(result) {
      if (predicate(result.events)) return PASS;
      return fail(`event predicate "${label}" did not hold`);
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

function truncate(text: string | undefined, max = 200): string {
  if (text === undefined) return "undefined";
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
