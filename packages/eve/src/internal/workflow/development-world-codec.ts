// World values are not plain JSON: run records carry Dates, stream chunks
// carry Uint8Arrays, and rejections must rehydrate into real Errors on the
// caller's side so the workflow runtime observes the same values it would
// from an in-process World. This codec exists only to preserve those shapes
// across the parent/worker HTTP boundary.
const VALUE_TYPE_KEY = "__eveDevelopmentWorldType";
const DATE_MARKER = "date";
const OBJECT_MARKER = "object";
const UINT8_ARRAY_MARKER = "uint8-array";
const UNDEFINED_MARKER = "undefined";

interface EncodedValue {
  readonly [VALUE_TYPE_KEY]: string;
  readonly data?: unknown;
}

export interface SerializedDevelopmentWorldError {
  readonly details: Readonly<Record<string, unknown>>;
  readonly message: string;
  readonly name: string;
  readonly stack?: string;
}

export function encodeDevelopmentWorldValue(value: unknown): string {
  return JSON.stringify({ value: encodeValue(value) });
}

export function decodeDevelopmentWorldValue(source: string): unknown {
  const decoded = JSON.parse(source) as unknown;
  return isRecord(decoded) ? decodeTransportValue(decoded.value) : undefined;
}

export function decodeDevelopmentWorldJson(source: string): unknown {
  return decodeWorkflowJsonValue(JSON.parse(source) as unknown);
}

export function serializeDevelopmentWorldError(error: unknown): SerializedDevelopmentWorldError {
  if (!(error instanceof Error)) {
    return { details: {}, message: String(error), name: "Error" };
  }
  return {
    details: Object.fromEntries(Object.entries(error)),
    message: error.message,
    name: error.name,
    stack: error.stack,
  };
}

export function deserializeDevelopmentWorldError(value: unknown): Error | undefined {
  if (!isRecord(value) || !isRecord(value.details)) {
    return undefined;
  }
  if (typeof value.message !== "string" || typeof value.name !== "string") {
    return undefined;
  }
  const error = new Error(value.message);
  error.name = value.name;
  if (typeof value.stack === "string") {
    error.stack = value.stack;
  }
  Object.assign(error, value.details);
  return error;
}

function encodeValue(value: unknown): unknown {
  if (value === undefined) {
    return { [VALUE_TYPE_KEY]: UNDEFINED_MARKER } satisfies EncodedValue;
  }
  if (value instanceof Date) {
    return {
      [VALUE_TYPE_KEY]: DATE_MARKER,
      data: value.toISOString(),
    } satisfies EncodedValue;
  }
  if (value instanceof Uint8Array) {
    return {
      [VALUE_TYPE_KEY]: UINT8_ARRAY_MARKER,
      data: Buffer.from(value).toString("base64"),
    } satisfies EncodedValue;
  }
  if (Array.isArray(value)) {
    return value.map((item) => encodeValue(item));
  }
  if (isRecord(value)) {
    return {
      [VALUE_TYPE_KEY]: OBJECT_MARKER,
      data: Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, encodeValue(item)]),
      ),
    } satisfies EncodedValue;
  }
  return value;
}

function decodeTransportValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => decodeTransportValue(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  if (value[VALUE_TYPE_KEY] === UNDEFINED_MARKER) {
    return undefined;
  }
  if (value[VALUE_TYPE_KEY] === DATE_MARKER && typeof value.data === "string") {
    return new Date(value.data);
  }
  if (value[VALUE_TYPE_KEY] === UINT8_ARRAY_MARKER && typeof value.data === "string") {
    return Uint8Array.from(Buffer.from(value.data, "base64"));
  }
  if (value[VALUE_TYPE_KEY] === OBJECT_MARKER && isRecord(value.data)) {
    return Object.fromEntries(
      Object.entries(value.data).map(([key, item]) => [key, decodeTransportValue(item)]),
    );
  }
  throw new Error("Development Workflow World transport contained an invalid encoded value.");
}

function decodeWorkflowJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => decodeWorkflowJsonValue(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  if (
    Object.keys(value).length === 2 &&
    value.__type === "Uint8Array" &&
    typeof value.data === "string"
  ) {
    return Uint8Array.from(Buffer.from(value.data, "base64"));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, decodeWorkflowJsonValue(item)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
