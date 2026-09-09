import { Buffer } from "node:buffer";

import { parse, stringify } from "#compiled/devalue/index.js";

import { ComputeError } from "#compute/errors.js";
import type { WireValue } from "#compute/protocol.js";

export const EVE_VALUE_CODEC = "eve-value-v1";

const reducers = {
  Buffer(value: unknown): Uint8Array | false {
    return Buffer.isBuffer(value) ? Uint8Array.from(value) : false;
  },
};

const revivers = {
  Buffer(value: unknown): Buffer {
    if (!(value instanceof Uint8Array)) {
      throw new Error("Invalid Buffer payload.");
    }
    return Buffer.from(value);
  },
};

export function encodeWireValue(value: unknown): WireValue {
  try {
    return {
      codec: EVE_VALUE_CODEC,
      data: stringify(value, reducers),
    };
  } catch {
    throw new ComputeError("INVALID_INPUT", "Value cannot be encoded with eve-value-v1.");
  }
}

export function decodeWireValue(value: WireValue): unknown {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.keys(value).length !== 2 ||
    value.codec !== EVE_VALUE_CODEC ||
    typeof value.data !== "string"
  ) {
    throw new ComputeError("INVALID_INPUT", "Invalid eve-value-v1 envelope.");
  }

  try {
    return parse(value.data, revivers);
  } catch {
    throw new ComputeError("INVALID_INPUT", "Invalid eve-value-v1 payload.");
  }
}
