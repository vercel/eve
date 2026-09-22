import { shouldCaptureInstrumentationContent } from "#shared/instrumentation-content.js";
import type { ConversationContext } from "#shared/conversation-context.js";
import {
  DROP_INSTRUMENTATION,
  type InstrumentationDecision,
} from "#shared/instrumentation-decision.js";
import type { JsonValue } from "#shared/json.js";

export interface InstrumentationPropertyBag {
  readonly [key: string]: JsonValue;
}

export interface UnclassifiedTraceCaptureContext extends Omit<ConversationContext, "channel"> {
  readonly agentName: string;
  readonly channel: ConversationContext["channel"] & {
    readonly metadata?: InstrumentationPropertyBag;
    readonly state?: InstrumentationPropertyBag;
  };
}

export type ClassificationField<TClassification extends JsonValue | never> = [
  TClassification,
] extends [never]
  ? { readonly classification?: JsonValue }
  : { readonly classification: TClassification };

export type TraceCaptureContext<TClassification extends JsonValue | never = never> =
  UnclassifiedTraceCaptureContext & ClassificationField<TClassification>;

export interface ClassificationPolicyContext {
  readonly abortSignal: AbortSignal;
}

export interface TraceClassificationInput {
  readonly boundary: "trace";
  readonly trace: UnclassifiedTraceCaptureContext;
}

export interface RecordClassificationInput<TRecord, TClassification extends JsonValue> {
  readonly boundary: "record";
  readonly record: TRecord;
  readonly trace: UnclassifiedTraceCaptureContext;
  readonly traceClassification: TClassification;
}

export type ClassificationPolicy<TRecord, TClassification extends JsonValue> = (
  input: TraceClassificationInput | RecordClassificationInput<TRecord, TClassification>,
  context: ClassificationPolicyContext,
) => TClassification | PromiseLike<TClassification>;

export type TracePolicyDecision =
  | { readonly emit: false }
  | {
      readonly emit: true;
      readonly recordInputs: boolean;
      readonly recordOutputs: boolean;
    };

export type TraceCapturePolicy<TClassification extends JsonValue | never = never> = (
  trace: TraceCaptureContext<TClassification>,
) => TracePolicyDecision | boolean;

export function resolveTracePolicy<TClassification extends JsonValue | never = never>(
  policy: TraceCapturePolicy<TClassification> | undefined,
  trace: TraceCaptureContext<TClassification>,
  onError?: (error: unknown) => void,
): InstrumentationDecision {
  try {
    const decision = policy?.(trace);
    return resolveTracePolicyDecision(
      decision ?? {
        emit: true,
        recordInputs: trace.audience === "public" || trace.environment === "development",
        recordOutputs: trace.audience === "public" || trace.environment === "development",
      },
      trace,
    );
  } catch (error) {
    try {
      onError?.(error);
    } catch {}
    return DROP_INSTRUMENTATION;
  }
}

export function resolveTracePolicyDecision(
  decision: TracePolicyDecision | boolean,
  context: {
    readonly audience: TraceCaptureContext["audience"];
    readonly environment: TraceCaptureContext["environment"];
  },
): InstrumentationDecision {
  if (decision === false) return DROP_INSTRUMENTATION;
  if (decision === true) {
    const content = shouldCaptureInstrumentationContent(context);
    return { action: "record", recordInputs: content, recordOutputs: content };
  }
  if (!decision.emit) return DROP_INSTRUMENTATION;
  return {
    action: "record",
    recordInputs: decision.recordInputs,
    recordOutputs: decision.recordOutputs,
  };
}
