import { createInstrumentationDispatcher } from "#instrumentation/dispatch.js";
import type {
  InstrumentationEvent,
  InstrumentationHooksInput,
} from "#instrumentation/lifecycle.js";
import type { JsonValue } from "#shared/json.js";
import type { TraceCaptureContext } from "#shared/trace-policy.js";

/** Provider-neutral hook operations consumed by the AI SDK bridge. */
export interface InstrumentationHooks {
  /** Framework classification retained for this bound trace. */
  readonly classification?: JsonValue;
  /**
   * Whether any provider admitted by this bound trace requests content.
   *
   * False means nothing downstream can read what was said, so the publisher
   * should not serialize it in the first place. This is the only way the
   * projection is skipped rather than merely withheld.
   */
  readonly capturesContent: boolean;
  /** Input-content demand for publishers that can project directions separately. */
  readonly capturesInputs?: boolean;
  /** Output-content demand for publishers that can project directions separately. */
  readonly capturesOutputs?: boolean;
  readonly forTrace?: (trace: TraceCaptureContext) => InstrumentationHooks;
  readonly prepareTrace?: (trace: TraceCaptureContext) => Promise<InstrumentationHooks>;
  publish(event: InstrumentationEvent): Promise<void>;
}

export interface CreateInstrumentationHooksOptions {
  readonly handlerTimeoutMs?: number;
}

/** Creates failure-isolated hooks backed by normalized dispatch groups. */
export function createInstrumentationHooks(
  input: InstrumentationHooksInput,
  options: CreateInstrumentationHooksOptions = {},
): InstrumentationHooks {
  return createInstrumentationDispatcher(input, options);
}
