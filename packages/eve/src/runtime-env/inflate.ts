import { constants, inflateSync } from "node:zlib";

export function inflateBounded(data: Uint8Array, maxBytes: number): Uint8Array | undefined {
  try {
    return inflateSync(data, { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength: maxBytes });
  } catch {
    return undefined;
  }
}
