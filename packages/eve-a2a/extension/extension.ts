import { defineExtension } from "eve/extension";
import { z } from "zod";

const credentials = z.object({ username: z.string().min(1), passwordEnv: z.string().min(1) });

export default defineExtension({
  config: z.object({
    server: z.object({
      origin: z.string().url(),
      signingSecretEnv: z.string().min(1),
      users: z.array(credentials).min(1),
    }),
    remote: credentials.extend({ origin: z.string().url() }),
  }),
});
