import { defineExtension } from "eve/extension";
import { z } from "zod";

import type { Takeover } from "./lib/takeover.ts";

export type { Takeover, TakeoverOptions, TakeoverSource } from "./lib/takeover.ts";

const takeoverValue = z.custom<Takeover>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "keys" in value &&
    "options" in value &&
    typeof (value as { baseUrl?: unknown }).baseUrl === "function",
  { message: "Pass the value defineTakeover() returns." },
);

export default defineExtension({
  config: z.object({
    /** The shared configuration from `defineTakeover`, also passed to the extensions that offer takeover tools. */
    takeover: takeoverValue,
  }),
});
