import { gateway, generateText } from "ai";

import type { BenchmarkRunArtifact } from "./types.js";

export const DEFAULT_SUMMARY_MODEL = "openai/gpt-5.4-mini";

/** Uses a separate inexpensive model to turn a run artifact into an operator summary. */
export async function summarizeRun(
  artifact: BenchmarkRunArtifact,
  model = DEFAULT_SUMMARY_MODEL,
): Promise<{ model: string; text: string }> {
  const result = await generateText({
    model: gateway(model),
    system: [
      "You summarize coding-agent benchmark runs for framework maintainers.",
      "Be concise, factual, and chronological.",
      "Describe what the agent tried, what actually succeeded, where it deviated from the intended path, and the final user-facing claim.",
      "Distinguish benchmark infrastructure failures from subject-agent failures.",
      "Do not suggest fixes or repeat raw logs. Use 4-8 bullets and end with a one-sentence verdict.",
    ].join(" "),
    prompt: JSON.stringify(summaryInput(artifact)),
    maxOutputTokens: 700,
  });
  return { model, text: result.text.trim() };
}

function summaryInput(artifact: BenchmarkRunArtifact): unknown {
  return {
    caseId: artifact.caseId,
    harness: artifact.harness,
    subjectRevision: artifact.subjectRevision,
    transcript: artifact.transcript,
    toolCalls: artifact.toolCalls.map((call) => ({ name: call.name, input: call.input })),
    toolResults: artifact.toolResults.map((result) => ({
      name: result.name,
      output: truncate(stringify(result.output), 2_000),
    })),
    worldEvents: artifact.worldEvents,
    checks: artifact.grade.checks,
    runError: artifact.error,
  };
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}
