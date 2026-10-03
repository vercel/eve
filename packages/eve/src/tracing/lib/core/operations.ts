import type { ScopeTerminal, ModelOptions } from "./scope-lifecycle.js";
import type {
  TraceSnapshot,
  TraceReference,
  CaptureDecision,
  Attributes,
  TraceLink,
} from "./types.js";
export interface OperationFacts {
  identity: import("./scope-lifecycle.js").ScopeIdentity;
  capture: CaptureDecision;
  operationId: string;
  reference?: TraceReference;
  parent?: TraceReference;
  startTimeMs?: number;
  links?: readonly TraceLink[];
  context?: object;
  attributes?: Attributes;
  attempt?: { index: number; attempt: number };
}

export interface Operation {
  readonly type: "activation" | "step" | "model" | "action" | "tool" | "approval" | "memory";
  readonly reference: TraceReference;
  readonly parent?: TraceReference;
  readonly startTimeMs: number;
  readonly capture: CaptureDecision;
  readonly finished: boolean;
  snapshot(): TraceSnapshot;
  run<T>(execute: () => T, ceiling?: CaptureDecision): T;
  attributes(attributes: Attributes): void;
  update(input: { attributes?: Attributes; links?: readonly TraceLink[] }): void;
  complete(
    result?: ScopeTerminal & { errorType?: string; result?: ScopeTerminal["model"] },
  ): Promise<void>;
  fail(error: unknown): Promise<void>;
  modelCall(input: ModelOptions, key?: string): Promise<Operation>;
  attach(parent: TraceReference, context?: object): Promise<void>;
  drain(result?: ScopeTerminal): Promise<void>;
}
