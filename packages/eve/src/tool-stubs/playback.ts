import { isObject } from "#shared/guards.js";
import { createStubValidator } from "#tool-stubs/schema.js";
import type { StubCall, StubResult, ToolStub } from "#tool-stubs/types.js";

/**
 * Selects stub outcomes and advances their sequences.
 * The surrounding workflow orders calls and restores progress on replay.
 */
export class StubPlayback {
  private readonly rules;
  private readonly results = new Map<string, StubResult>();
  private readonly positions = new Map<string, number>();

  constructor(rules: readonly ToolStub[]) {
    this.rules = rules.map((rule) => ({
      ...rule,
      constraints: Object.entries(rule.match ?? {}).map(([property, schema]) => {
        try {
          return { property, validator: createStubValidator(schema) };
        } catch (cause) {
          throw new Error(
            `Could not create validator for matcher "${property}" in tool stub "${rule.id}".`,
            {
              cause,
            },
          );
        }
      }),
    }));
  }

  get matchedRuleCount(): number {
    return this.positions.size;
  }

  call(call: StubCall): StubResult {
    const recorded = this.results.get(call.callId);
    if (recorded !== undefined) return recorded;
    if (this.results.size >= 10_000)
      return {
        kind: "error",
        error: "Tool stub session exceeded 10,000 calls. Start a new eval session.",
      };
    const candidates = this.rules.filter((rule) => rule.tool === call.tool);
    if (call.persistent && candidates.some((rule) => rule.constraints.length > 0)) {
      return this.record(call, {
        kind: "error",
        error: `Persistent tool "${call.tool}" requires an unconditional stub.`,
      });
    }
    const rule = candidates.find((rule) =>
      rule.constraints.every(
        ({ property, validator }) =>
          isObject(call.input) &&
          Object.hasOwn(call.input, property) &&
          validator.validate(call.input[property]).valid,
      ),
    );
    if (rule === undefined) return this.record(call, { kind: "real" });
    const outcomes = rule.outcomes ?? [rule.outcome!];
    const position = Math.min(this.positions.get(rule.id) ?? 0, outcomes.length - 1);
    this.positions.set(rule.id, position + 1);
    return this.record(call, {
      kind: "stub",
      ruleId: rule.id,
      position,
      outcome: outcomes[position]!,
    });
  }

  private record(call: StubCall, result: StubResult): StubResult {
    this.results.set(call.callId, result);
    return result;
  }

  fail(callId: string, error: string): StubResult {
    return this.results.get(callId)?.kind === "stub" ? { kind: "error", error } : { kind: "real" };
  }
}
