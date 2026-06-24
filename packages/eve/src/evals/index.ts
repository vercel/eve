// ---------------------------------------------------------------------------
// Eval definition
// ---------------------------------------------------------------------------

export { defineEval } from "#evals/define-eval.js";
export { defineEvalConfig } from "#evals/define-eval-config.js";
export { EveEvalTurnFailedError } from "#evals/session.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { RuntimeIdentity } from "#protocol/message.js";
export type { InputRequest } from "#runtime/input/types.js";

export type {
  EveEvalValueMatcher,
  EveEvalToolCallMatchOptions,
  EveEvalSkillLoadMatchOptions,
  EveEvalSubagentCallMatchOptions,
} from "#evals/match.js";

export type {
  Assertion,
  AssertionHandle,
  AssertionResult,
  AssertionSeverity,
  AutoevalsJudges,
  EveEvalContext,
  EveEvalDerivedFacts,
  EveEvalJudgeConfig,
  EveEvalRunSummary,
  EveEvalSession,
  EveEvalSessionResult,
  EveEvalScheduleDispatchResult,
  EveEvalSubagentCall,
  EveEval,
  EveEvalConfig,
  EveEvalConfigInput,
  EveEvalDefinition,
  EveEvalInput,
  EveEvalResult,
  EveEvalTarget,
  EveEvalTargetCapabilities,
  EveEvalTargetHandle,
  EveEvalTaskResult,
  EveEvalToolCall,
  EveEvalTurn,
  EveEvalVerdict,
  JudgeContext,
  JudgeOpts,
} from "#evals/types.js";
