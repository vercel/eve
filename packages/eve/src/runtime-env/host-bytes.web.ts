import { concatBytes } from "#shared/bytes.js";
import type { concatHostBytes as NodeConcat, hostBytes as NodeCopy } from "./host-bytes.js";

export const hostBytes: typeof NodeCopy = (bytes) => bytes.slice();
export const concatHostBytes: typeof NodeConcat = (chunks) => concatBytes(chunks);
