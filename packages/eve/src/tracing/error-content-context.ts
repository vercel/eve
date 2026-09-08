import { context, createContextKey, type Context } from "#compiled/@opentelemetry/api/index.js";

const ERROR_CONTENT_KEY = createContextKey("eve.trace.error-content");

export function withErrorContent(context: Context, allowed: boolean): Context {
  return context.setValue(ERROR_CONTENT_KEY, allowed);
}

export function capturesErrorContent(): boolean {
  return context.active().getValue(ERROR_CONTENT_KEY) !== false;
}
