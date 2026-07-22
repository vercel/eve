import type { DeliverHookPayload } from "#channel/types.js";
import type {
  ChildrenHandle as CoreChildrenHandle,
  ChildResults as CoreChildResults,
  CompletedTurn as CoreCompletedTurn,
  GenerateInput as CoreGenerateInput,
  LoopTypes,
  SessionAdvance as CoreSessionAdvance,
  SessionBackend as CoreSessionBackend,
  SuspendedTurn as CoreSuspendedTurn,
  TurnBackend as CoreTurnBackend,
  TurnHandle as CoreTurnHandle,
  TurnInput as CoreTurnInput,
  TurnOutcome as CoreTurnOutcome,
  TurnProgramInput as CoreTurnProgramInput,
  TurnStepResult as CoreTurnStepResult,
} from "#core/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";
import type { TokenUsage } from "#shared/token-usage.js";

/** The single binding from eve runtime values to the engine-neutral loop core. */
export interface EveLoopTypes extends LoopTypes {
  readonly childResult: RuntimeActionResult;
  readonly delivery: DeliverHookPayload;
  readonly state: {
    readonly durable: DurableSessionState;
    readonly serializedContext: Record<string, unknown>;
  };
  readonly usage: TokenUsage;
}

export type ChildrenHandle = CoreChildrenHandle<EveLoopTypes>;
export type ChildResults = CoreChildResults<EveLoopTypes>;
export type CompletedTurn = CoreCompletedTurn<EveLoopTypes>;
export type GenerateInput = CoreGenerateInput<EveLoopTypes>;
export type SessionAdvance = CoreSessionAdvance<EveLoopTypes>;
export type SessionBackend = CoreSessionBackend<EveLoopTypes>;
export type SessionState = EveLoopTypes["state"];
export type SuspendedTurn = CoreSuspendedTurn<EveLoopTypes>;
export type TurnBackend = CoreTurnBackend<EveLoopTypes>;
export type TurnHandle = CoreTurnHandle<EveLoopTypes>;
export type TurnInput = CoreTurnInput<EveLoopTypes>;
export type TurnOutcome = CoreTurnOutcome<EveLoopTypes>;
export type TurnProgramInput = CoreTurnProgramInput<EveLoopTypes>;
export type TurnStepResult = CoreTurnStepResult<EveLoopTypes>;
