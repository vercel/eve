import type { inflateBounded as NodeTwin } from "./inflate.js";

// A browser has no synchronous inflate (only the async `DecompressionStream`), so compressed data
// reads as not inflatable, as corrupt data does in Node: callers treat what's inside as unknown.
// `inflate.ts` is the Node twin.

export const inflateBounded: typeof NodeTwin = () => undefined;
