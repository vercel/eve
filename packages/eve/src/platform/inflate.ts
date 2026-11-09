import { constants, inflateSync } from "node:zlib";

// zlib inflate, synchronously, bounded to `maxBytes` of output; `undefined` when the data doesn't
// inflate. `inflate.web.ts` is the browser's twin; the package's `#platform/*` imports pick one
// by the `node` condition.

export function inflateBounded(data: Uint8Array, maxBytes: number): Uint8Array | undefined {
  try {
    return inflateSync(data, { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength: maxBytes });
  } catch {
    return undefined;
  }
}
