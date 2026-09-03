import { traceCoordinatesSchema, type TraceCoordinates } from "#protocol/agent-invocation-trace.js";

export const ACCEPTED_TRACE_COORDINATES_METADATA_KEY = "eveAcceptedTraceCoordinates";

export function readAcceptedTraceCoordinatesMetadata(value: unknown): TraceCoordinates | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const metadata = Reflect.get(value, "metadata");
  if (metadata === null || typeof metadata !== "object") return undefined;
  const parsed = traceCoordinatesSchema.safeParse(
    Reflect.get(metadata, ACCEPTED_TRACE_COORDINATES_METADATA_KEY),
  );
  return parsed.success ? parsed.data : undefined;
}
