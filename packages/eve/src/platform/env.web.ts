import type { readEnv as NodeTwin } from "./env.js";

// A browser has no environment variables: every one reads as unset, as it does in Node when it
// isn't set. `env.ts` is the Node twin.

export const readEnv: typeof NodeTwin = () => undefined;
