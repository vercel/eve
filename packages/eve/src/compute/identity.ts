import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { ComputeError } from "#compute/errors.js";
import { assertLocalKey } from "#compute/validation.js";

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashRequest(parts: readonly unknown[]): Uint8Array {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest();
}

export function composeDeliveryKey(deliveryId: string, localKey: string): string {
  assertLocalKey(localKey, "transition key");
  const composed = JSON.stringify([deliveryId, localKey]);
  if (Buffer.byteLength(composed, "utf8") > 512) {
    throw new ComputeError("INVALID_INPUT", "Composed transition key exceeds 512 UTF-8 bytes.");
  }
  return composed;
}
