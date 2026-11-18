import { defineExtension } from "eve/extension";
import { z } from "zod";

export default defineExtension({
  config: z.object({
    channelName: z.string().min(1).default("slack"),
    workspaces: z.record(
      z.string().regex(/^T[A-Z0-9]+$/u),
      z.object({
        botTokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/u),
        channels: z.record(z.string().regex(/^[CG][A-Z0-9]+$/u), z.string().regex(/^F[A-Z0-9]+$/u)),
      }),
    ),
  }),
});
