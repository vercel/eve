// ---------------------------------------------------------------------------
// Eval definition
// ---------------------------------------------------------------------------

export { defineEval } from "#evals/define-eval.js";
export { defineEvalConfig } from "#evals/define-eval-config.js";
export { EveEvalTurnFailedError } from "#evals/session.js";
export { mockModel } from "#evals/mock-model.js";
export { toolCallsOf } from "#evals/tool-calls.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { RuntimeIdentity, TraceContext } from "#protocol/session-events/families/session.js";
export type { Interaction } from "#protocol/session-reader.js";
export type { CancelSessionResult } from "#client/types.js";

export type {
  EveEvalCountMatcher,
  EveEvalEventMatch,
  EveEvalInteractionMatchOptions,
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
  EveEvalActionStatus,
  EveEvalAgentSession,
  EveEvalAssertions,
  EveEvalContext,
  EveEvalDerivedFacts,
  EveEvalJudgeConfig,
  EveEvalRunSummary,
  EveEvalSession,
  EveEvalSessionResult,
  EveEvalScheduleDispatchResult,
  EveEvalSkillLoad,
  EveEvalSubagentCall,
  EveEval,
  EveEvalConfig,
  EveEvalConfigInput,
  EveEvalConfigContext,
  EveEvalDefinition,
  EveEvalInput,
  EveEvalLiveTurn,
  EveEvalWatchOptions,
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
  JudgeBatch,
  JudgeInput,
  JudgeQuestion,
  JudgeContext,
  JudgeOpts,
  ScoreInput,
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
export type { ToolStub, ToolStubOutcome } from "#tool-stubs/types.js";
