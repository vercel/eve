import { context, createContextKey } from "@opentelemetry/api";
import type { CaptureDecision } from "./core/types.js";

const CAPTURE = createContextKey("agent.tracing.capture");
/** Returns the capture decision set on the active OpenTelemetry context, or `undefined` when none is set. */
export function currentCapture(): CaptureDecision | undefined {
  return context.active().getValue(CAPTURE) as CaptureDecision | undefined;
}
/** Returns `host` with `capture` set as its capture decision, which {@link currentCapture} reads while it is active. */
export function withCapture<T extends { setValue(key: symbol, value: unknown): T }>(
  host: T,
  capture: CaptureDecision,
): T {
  return host.setValue(CAPTURE, capture);
}
