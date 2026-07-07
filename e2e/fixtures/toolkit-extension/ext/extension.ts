import { defineExtension } from "eve/extension";
import { z } from "zod";

// The extension declaration: its default export is the mount factory the
// consuming agent calls (`toolkit({ apiKey, tier })`), and the extension's own
// tools read the bound, validated config off this handle via `extension.config`.
export default defineExtension({
  config: z.object({
    apiKey: z.string(),
    tier: z.string().default("free"),
  }),
});
