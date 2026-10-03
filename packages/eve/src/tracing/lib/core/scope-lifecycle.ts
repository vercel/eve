import type { TraceReference, TraceLink, Usage } from "./types.js";
import type { CaptureDecision } from "./types.js";
import type { RunIdentity, FrameworkIdentity } from "./types.js";

export type ScopeData =
  | { readonly type: "activation"; readonly options: TurnMetadata }
  | { readonly type: "step"; readonly options: StepOptions }
  | { readonly type: "model"; readonly options: ModelOptions }
  | { readonly type: "action"; readonly options: ActionOptions }
  | {
      readonly type: "tool";
      readonly options: {
        readonly callId: string;
        readonly name: string;
        readonly arguments?: unknown;
      };
    }
  | {
      readonly type: "approval";
      readonly options: ApprovalOptions & { readonly callId: string; readonly actionName: string };
    }
  | { readonly type: "memory"; readonly options: MemoryOptions };

export interface ScopeIdentity extends RunIdentity {
  readonly agentName?: string;
  readonly framework?: FrameworkIdentity;
}

/** Detached state persisted by the runtime with its workflow checkpoint. */
export interface ScopeRecord {
  readonly pendingParent?: boolean;
  readonly version?: 1;
  readonly finished?: boolean;
  readonly key: string;
  readonly identity: ScopeIdentity;
  readonly data: ScopeData;
  readonly reference: TraceReference;
  readonly parent?: TraceReference;
  readonly attempt?: { readonly index: number; readonly attempt: number };
  readonly capture: CaptureDecision;
  readonly startTimeMs: number;
  readonly links?: readonly TraceLink[];
  readonly usage?: Usage;
  readonly usageKeys?: readonly string[];
  readonly attributes?: import("./types.js").Attributes;
  readonly childSequence?: number;
  readonly children?: readonly ScopeRecord[];
  readonly terminal?: ScopeTerminal;
}

import type { ActionKind } from "./types.js";
import type { ChannelMetadata } from "./contract.js";

export interface TurnMetadata {
  readonly attributes?: import("./types.js").Attributes;
  readonly sequence: number;
  readonly subagent?: boolean;
  readonly subagentName?: string;
  readonly parentCallId?: string;
  readonly parentRunId?: string;
  readonly channel?: ChannelMetadata;
}

export interface StepOptions {
  readonly index: number;
  readonly attempt?: number;
  readonly channel?: ChannelMetadata;
  readonly runtimeContext?: Readonly<Record<string, unknown>>;
}

export interface ModelOptions {
  readonly provider: string;
  readonly modelId: string;
  readonly messages?: readonly unknown[];
  readonly instructions?: unknown;
  readonly runtimeContext?: Readonly<Record<string, unknown>>;
}

export interface ActionOptions {
  readonly callId: string;
  readonly name: string;
  readonly kind?: ActionKind;
  readonly arguments?: unknown;
}

export interface ApprovalOptions {
  readonly requestId: string;
  readonly request?: unknown;
}

export interface MemoryOptions {
  readonly operation: "search_memory" | "upsert_memory";
  readonly phase: string;
  readonly slot: string;
  readonly storeId: string;
}

export interface ScopeTerminal {
  readonly outcome?: string;
  readonly failed?: boolean;
  readonly error?: unknown;
  readonly errorCode?: string;
  readonly output?: unknown;
  readonly response?: unknown;
  readonly usage?: Usage;
  readonly model?: ModelResult;
  readonly recordCount?: number;
  readonly records?: readonly { id?: string; content: string }[];
  readonly endTimeMs?: number;
}

import type { modelResultAttributes } from "./model.js";
export type ModelResult = Parameters<typeof modelResultAttributes>[0];
