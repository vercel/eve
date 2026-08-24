// ---------------------------------------------------------------------------
// Eval definition
// ---------------------------------------------------------------------------

export { defineEval } from "#evals/define-eval.js";
export { defineEvalConfig } from "#evals/define-eval-config.js";
export { EveEvalTurnFailedError } from "#evals/session.js";
export { mockModel } from "#evals/mock-model.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { RuntimeIdentity, RuntimeTraceContext } from "#protocol/message.js";
export type { InputRequest } from "#shared/input.js";
export type { CancelSessionResult } from "#client/types.js";

export type {
  EveEvalCountMatcher,
  EveEvalEventMatch,
  EveEvalInputRequestMatchOptions,
  EveEvalValueMatcher,
  EveEvalToolCallMatchOptions,
  EveEvalSkillLoadMatchOptions,
  EveEvalSubagentCallMatchOptions,
} from "#evals/match.js";

export type {
  Assertion,
  AssertionEvaluation,
  AssertionHandle,
  AssertionResult,
  AssertionSeverity,
  AutoevalsJudges,
  EveEvalActionStatus,
  EveEvalAssertions,
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
  EveEvalLiveTurn,
  EveEvalResult,
  EveEvalTarget,
  EveEvalTargetCapabilities,
  EveEvalTargetHandle,
  EveEvalTaskResult,
  EveEvalTraceContext,
  EveEvalToolCall,
  EveEvalTurn,
  EveEvalStreamEvent,
  EveEvalWaitForEventOptions,
  EveEvalVerdict,
  JudgeContext,
  JudgeOpts,
} from "#evals/types.js";

export type {
  MockModelMessage,
  MockModelOptions,
  MockModelRequest,
  MockModelResponder,
  MockModelResponse,
  MockModelTool,
  MockModelToolCall,
  MockModelToolResult,
  MockModelUsage,
} from "#evals/mock-model.js";
