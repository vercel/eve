import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { AssertionCollector } from "#evals/assertions/collector.js";
import * as RunAssertions from "#evals/assertions/run.js";
import type { EveEvalAssertionSubject } from "#evals/assertions/run.js";
import type { EveEvalEventMatch } from "#evals/match.js";
import type { EveEvalAssertions, EveEvalTaskResult } from "#evals/types.js";

/** Binds the shared assertion vocabulary to one aggregate, session, or turn scope. */
export function createScopedAssertions(
  collector: AssertionCollector,
  selectSubject: (result: EveEvalTaskResult) => EveEvalAssertionSubject,
): EveEvalAssertions {
  const record = (assertion: ReturnType<typeof RunAssertions.completed>) =>
    collector.recordScoped(assertion, selectSubject);

  function event(
    typeOrPredicate:
      | HandleMessageStreamEvent["type"]
      | ((events: readonly HandleMessageStreamEvent[]) => boolean),
    optionsOrLabel?: Omit<EveEvalEventMatch, "type"> | string,
  ) {
    if (typeof typeOrPredicate === "function") {
      return record(RunAssertions.event(typeOrPredicate, String(optionsOrLabel ?? "predicate")));
    }
    const matcher = { type: typeOrPredicate } as EveEvalEventMatch;
    if (typeof optionsOrLabel === "object") Object.assign(matcher, optionsOrLabel);
    return record(RunAssertions.typedEvent(matcher));
  }

  return {
    completed: () => record(RunAssertions.completed()),
    didNotFail: () => record(RunAssertions.didNotFail()),
    waiting: () => record(RunAssertions.waiting()),
    messageIncludes: (token) => record(RunAssertions.messageIncludes(token)),
    calledTool: (name, options) => record(RunAssertions.calledTool(name, options)),
    loadedSkill: (skill, options) => record(RunAssertions.loadedSkill(skill, options)),
    notCalledTool: (name, options) => record(RunAssertions.notCalledTool(name, options)),
    toolOrder: (names, options) => record(RunAssertions.toolOrder(names, options)),
    usedNoTools: () => record(RunAssertions.usedNoTools()),
    maxToolCalls: (max) => record(RunAssertions.maxToolCalls(max)),
    calledSubagent: (name, options) => record(RunAssertions.calledSubagent(name, options)),
    noFailedActions: () => record(RunAssertions.noFailedActions()),
    event,
    notEvent: (type, options) =>
      record(RunAssertions.notEvent({ ...options, type } as EveEvalEventMatch)),
    eventOrder: (matchers) => record(RunAssertions.eventOrder(matchers)),
    outputEquals: (value) => record(RunAssertions.outputEquals(value)),
    outputMatches: (schema) => record(RunAssertions.outputMatches(schema)),
  };
}
