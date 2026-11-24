import type { ExtractionField } from "#ai/extraction-types.js";

export type ExtractionResultRecord =
  | {
      field_index: number;
      field_name: string;
      type: ExtractionField["type"];
      value: string | number | readonly (string | number)[] | null;
      confidence?: number;
    }
  | { field_index: number; field_name: string; type: "refusal" };

export function extractionResults(
  fields: Readonly<Record<string, ExtractionField>>,
  outcome:
    | { readonly answers: Readonly<Record<string, unknown>> }
    | { readonly refused: readonly string[] },
): ExtractionResultRecord[] {
  return Object.entries(fields).flatMap(([name, field], index): ExtractionResultRecord[] => {
    const base = { field_index: index, field_name: name };
    if ("refused" in outcome) {
      return outcome.refused.includes(name) ? [{ ...base, type: "refusal" }] : [];
    }
    const answer = outcome.answers[name] as Record<string, unknown> | undefined;
    if (answer?.type !== field.type) return [];
    const result: ExtractionResultRecord = {
      ...base,
      type: field.type,
      value: (answer.value ?? null) as Extract<ExtractionResultRecord, { value: unknown }>["value"],
    };
    if (typeof answer.confidence === "number") result.confidence = answer.confidence;
    return [result];
  });
}
