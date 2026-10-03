import type { ContentSerializer } from "./model.js";

export function boundedSerializer(
  serializer: ContentSerializer,
  maxBytes = 32768,
  onError?: import("./types.js").TraceErrorHandler,
): ContentSerializer {
  function invoke(method: keyof ContentSerializer, args: unknown[]): string | undefined {
    try {
      const value = Reflect.apply(serializer[method], serializer, args) as string | undefined;
      return value === undefined || new TextEncoder().encode(value).length > maxBytes
        ? undefined
        : value;
    } catch (error) {
      try {
        onError?.(error, { phase: "serialize" });
      } catch {}
      return undefined;
    }
  }
  return {
    json: (value) => invoke("json", [value]),
    text: (value) => invoke("text", [value]),
    inputMessages: (value) => invoke("inputMessages", [value]),
    instructions: (value) => invoke("instructions", [value]),
    outputMessages: (value, reason) => invoke("outputMessages", [value, reason]),
    toolResults: (value) => invoke("toolResults", [value]),
  };
}
