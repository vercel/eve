import {
  evaluateSemanticErrorRules,
  type SemanticErrorRule,
  type SemanticErrorSummary,
} from "./rule.js";
import { extractErrorSignals } from "./signals.js";
import { GATEWAY_RULES } from "./rules/gateway.js";
import { MODEL_PROVIDER_RULES } from "./rules/model-provider.js";
import { SANDBOX_RULES } from "./rules/sandbox.js";
import { SYSTEM_RULES } from "./rules/system.js";
import { WORKFLOW_RULES } from "./rules/workflow.js";

export type { ErrorLink, ErrorSignals } from "./signals.js";
export type { LinkPredicate, SemanticErrorRule, SemanticErrorSummary } from "./rule.js";

/**
 * The semantic-error catalog: an ordered list of declarative rules, linter
 * style, applied to any thrown error to classify it. Domain modules under
 * `rules/` each contribute independent rules keyed on structural signals
 * (`name`, `code`, gateway `type`, exact messages) — never on volatile
 * message prose — and the first matching rule wins, so specific rules come
 * before general ones and the broad network fallback comes last.
 *
 * This is the growth point: when a new raw error shows up in diagnostic
 * logs often enough to deserve a curated message, add a rule to the
 * matching domain module with a new stable `id`.
 */
const CATALOG: readonly SemanticErrorRule[] = [
  ...GATEWAY_RULES,
  ...MODEL_PROVIDER_RULES,
  ...WORKFLOW_RULES,
  ...SANDBOX_RULES,
  ...SYSTEM_RULES,
];

/**
 * Projects any thrown error into its cataloged semantic summary, or
 * `null` when no rule matches — callers then fall back to the raw
 * message plus the full diagnostic dump routed to the log.
 */
export function summarizeKnownError(error: unknown): SemanticErrorSummary | null {
  return evaluateSemanticErrorRules(CATALOG, extractErrorSignals(error));
}
