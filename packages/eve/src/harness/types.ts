import type { EveAttributeValue } from "#runtime/attributes/normalize.js";
import type { Fact, Progress } from "#protocol/session-events/facts.js";
import type { ConsumedDelivery } from "#harness/session-machine/transitions.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { LanguageModel } from "ai";
import type { MessageContent } from "#shared/message-content.js";

import type { SessionAuthContext, SessionCapabilities } from "#channel/types.js";
import type { RuntimeIdentity } from "#protocol/session-events/families/session.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import type { Answer } from "#shared/input.js";
import type { SandboxState } from "#sandbox/state.js";
import type { JsonObject } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type { Principal } from "#protocol/session-events/envelope.js";
import type { SessionUsageLimit } from "#shared/agent-definition.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { SessionInstrumentation } from "#instrumentation/runtime.js";
import type { SessionHistoryMessage } from "#shared/session-history.js";

export type SessionStateMap = Readonly<Record<string, unknown>>;

export interface CompactionState {
  readonly lastKnownInputTokens?: number;
  readonly lastKnownPromptMessageCount?: number;
  readonly requestEnvelopeTokens?: number;
}

export interface CompactionConfig extends CompactionState {
  readonly recentWindowSize: number;
  readonly threshold: number;
  readonly thresholdPercent?: number;
}

export interface HarnessSessionBase {
  readonly compaction: CompactionState;
  readonly continuationToken: string;
  readonly outputSchema?: JsonObject;
  readonly rootSessionId?: string;
  readonly sessionId: string;
  readonly sandboxState?: SandboxState;
  readonly state?: SessionStateMap;
}

export interface HarnessSession extends HarnessSessionBase {
  readonly history: HarnessModelMessage[];
}

export interface ControlDelivery {
  readonly deliveryId: string;
  readonly principal?: Principal;
}

export interface StepInput {
  readonly answers?: readonly Answer[];
  readonly message?: MessageContent;
  readonly context?: readonly string[];
  readonly history?: readonly SessionHistoryMessage[];
  readonly outputSchema?: JsonObject;
}

export interface SubmittedAnswer extends Answer {
  readonly responseId: string;
  readonly deliveryId: string;
  readonly responder?: SessionAuthContext | null;
}

export interface HarnessStepInput extends Omit<StepInput, "answers"> {
  readonly answers?: readonly SubmittedAnswer[];
  readonly runtimeActionResults?: readonly RuntimeActionResult[];
  readonly delegatedUsage?: Readonly<Record<string, TokenUsage>>;
  readonly deliveries?: readonly ConsumedDelivery[];
}

export interface StepDone {
  readonly done: true;
  readonly output: unknown;
  readonly isError?: boolean;
}

export type StepNext = StepDone | StepFn | null;

export interface SettledTurn {
  readonly output: unknown;
  readonly isError?: boolean;
  readonly usage?: TokenUsage;
}

export interface StepResult {
  readonly steered?: true;
  readonly next: StepNext;
  readonly session: HarnessSession;
  readonly settledTurn?: SettledTurn;
  readonly held?: TurnHold;
}

export type TurnHold =
  | { readonly kind: "tasks"; readonly taskIds: readonly string[] }
  | { readonly kind: "request" };

export type StepFn = (session: HarnessSession, input?: HarnessStepInput) => Promise<StepResult>;

export type HarnessToolMap = ReadonlyMap<string, HarnessToolDefinition>;

export type HarnessToolLookup = Pick<HarnessToolMap, "get">;

export interface ToolCallLike {
  readonly input: unknown;
  readonly toolName: string;
}

export interface ResolvedCall<T extends ToolCallLike> {
  readonly call: T;
  readonly definition: HarnessToolDefinition;
}

export type CallResolver = <T extends ToolCallLike>(toolCall: T) => ResolvedCall<T> | undefined;

declare const committedBrand: unique symbol;

export type Commit = readonly Fact[] & { readonly [committedBrand]: true };

export type SessionPublication = Commit | Progress;

export type HarnessEmitFn = HandleEventFn;

export interface StepCoordinates {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

export type HandleEventFn = (
  publication: SessionPublication,
  messages?: readonly import("ai").ModelMessage[],
) => Promise<void>;

export interface KernelConfig {
  readonly steeringSignal?: AbortSignal;
  readonly abortSignal?: AbortSignal;
  readonly capabilities?: SessionCapabilities;
  readonly sessionUsageLimit?: SessionUsageLimit;
  readonly clearOnly?: boolean;
  readonly compactOnly?: boolean;
  readonly controlDelivery?: ControlDelivery;
  readonly handleEvent?: HandleEventFn;
  readonly instrumentation?: SessionInstrumentation;
  readonly setAttributes?: (attributes: Record<string, EveAttributeValue>) => Promise<void>;
  readonly signInCompletions?: readonly AuthorizationChallenge[];
  readonly typedAnswers?: boolean;
  readonly resolveModel: (reference: RuntimeModelReference) => Promise<LanguageModel>;
  readonly runtimeIdentity?: RuntimeIdentity;
  readonly tools: HarnessToolMap;
}
