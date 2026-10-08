import { context, createContextKey } from "@opentelemetry/api";
import type { CaptureDecision } from "./core/types.js";

const CAPTURE = createContextKey("agent.tracing.capture");
export function currentCapture(): CaptureDecision | undefined {
  return context.active().getValue(CAPTURE) as CaptureDecision | undefined;
}
export function withCapture<T extends { setValue(key: symbol, value: unknown): T }>(
  host: T,
  capture: CaptureDecision,
): T {
  return host.setValue(CAPTURE, capture);
}
