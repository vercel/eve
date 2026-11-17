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

const CATALOG: readonly SemanticErrorRule[] = [
  ...GATEWAY_RULES,
  ...MODEL_PROVIDER_RULES,
  ...WORKFLOW_RULES,
  ...SANDBOX_RULES,
  ...SYSTEM_RULES,
];

export function summarizeKnownError(error: unknown): SemanticErrorSummary | null {
  return evaluateSemanticErrorRules(CATALOG, extractErrorSignals(error));
}
