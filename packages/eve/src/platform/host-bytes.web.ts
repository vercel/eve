import { concatBytes } from "#shared/bytes.js";
import type { concatHostBytes as NodeConcat, hostBytes as NodeCopy } from "./host-bytes.js";

// A browser's bytes are plain `Uint8Array`s. `host-bytes.ts` is the Node twin.

export const hostBytes: typeof NodeCopy = (bytes) => bytes.slice();
export const concatHostBytes: typeof NodeConcat = (chunks) => concatBytes(chunks);
