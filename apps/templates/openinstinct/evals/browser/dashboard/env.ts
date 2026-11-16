import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const dashboardEnv = createEnv({
  server: {
    BROWSER_BENCH_STATUS_PATH: z.string().min(1).optional(),
    INIT_CWD: z.string().min(1).optional(),
  },
  experimental__runtimeEnv: {},
  emptyStringAsUndefined: true,
});
