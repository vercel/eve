import { defineSkill } from "eve/skills";

import type { ResolvedSelfModificationConfig } from "../../../../config.js";
import { defineLocalOnlyDynamic, resolveLocalOnly } from "../../../local-only.js";

const traceAnalysisSkill = defineSkill({
  description:
    "Analyze local eve traces for latency, token usage, failures, repeated tool calls, and discovery inefficiency with a bounded investigation.",
  markdown: `# Trace analysis

Use this workflow when the user asks to review, diagnose, or optimize behavior from local traces.

## Keep the investigation bounded

1. Call \`search_traces\` once with \`sortBy\` set to the user's primary concern and \`limit\` no greater than 5. Use its \`sessionId\`, \`agentName\`, \`toolName\`, or \`failedOnly\` filters only when they directly narrow the question.
2. Rank findings across correctness, latency, token usage, and tool-call efficiency. Follow the user's stated priority; do not assume that "improve" means only fixing errors.
3. Call \`inspect_trace\` only for the one or two traces needed to explain a high-impact signal. Set \`limit\` to the smallest useful bound, normally 20–40. Its timeline includes bounded argument previews and \`availableFields\` for each span.
4. Use \`inspect_trace_spans\` only with span ids returned by a timeline. Include only the required payload fields and batch related spans in one call. An empty \`availableFields\` list means none are recorded, not that the call failed.
5. Use the read-only \`/logs\` mount only to corroborate a specific runtime error that the structural trace cannot explain. Search a literal diagnostic fragment with bounded output before reading a file. With no observed failure, skip broad log searches and speculative web searches for possible failures.
6. Inspect \`/source\` or \`/eve-docs\` only when evidence points to a persistent authored change or an unresolved API question.

Prefer three analysis rounds or fewer. Do not read raw trace segments, search the whole filesystem, or enumerate broad documentation when the bounded tools answer the question.

Search and inspection share the same summary. Its durationMs is elapsed time; inspection's modelWorkMs and toolWorkMs sum operation time and may exceed elapsed time when calls overlap. errorSpanCount counts error-bearing spans, not independent failures or final activation outcome; failures ranking uses this count. Token totals sum step usage without counting repeated model counters.

For latency, distinguish tool execution time from model round-trip time. Repeated tool counts are leads, not proof that calls are independent; inspect the compact timeline before recommending batching. Report the highest-impact opportunities first.
`,
});

export function resolveTraceAnalysisSkill(config: ResolvedSelfModificationConfig) {
  return resolveLocalOnly(config, traceAnalysisSkill);
}

export default defineLocalOnlyDynamic(traceAnalysisSkill);
