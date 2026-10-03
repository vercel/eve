import { context, propagation, trace, type TextMapGetter } from "@opentelemetry/api";
import { getInstrumentationRuntime } from "#instrumentation/runtime.js";
import { eveTransportLifecycle } from "#tracing/eve/transports.js";

export type ChannelRequestTrace = ReturnType<ReturnType<typeof eveTransportLifecycle>["request"]>;
const headersGetter: TextMapGetter<Headers> = {
  get: (headers, key) => headers.get(key) ?? undefined,
  keys: (headers) => [...headers.keys()],
};

/** The request lifetime ends at handler return, not response-body consumption. */
export async function traceChannelRequest<T extends Response>(
  input: { readonly request: Request; readonly routeKey: string },
  handler: (operation: ChannelRequestTrace | undefined) => Promise<T>,
): Promise<T> {
  if (getInstrumentationRuntime()?.otelSettings?.traceChannelRequests !== true)
    return handler(undefined);
  const { request, routeKey } = input;
  const parent = propagation.extract(context.active(), request.headers, headersGetter);
  const separator = routeKey.indexOf(" ");
  let url: URL | undefined;
  try {
    url = new URL(request.url);
  } catch {}
  const operation = eveTransportLifecycle().request({
    method: request.method,
    route: separator === -1 ? routeKey : routeKey.slice(separator + 1),
    scheme: url?.protocol.replace(/:$/, ""),
    serverAddress: url?.hostname,
    parent: trace.getSpan(parent)?.spanContext(),
    executionContext: parent,
  });
  try {
    const response = await operation.run(() => handler(operation));
    operation.completed(response.status);
    return response;
  } catch (error) {
    operation.failed();
    throw error;
  }
}
