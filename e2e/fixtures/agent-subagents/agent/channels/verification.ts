import { defineChannel, POST } from "eve/channels";
import { resumeHook } from "eve/workflow/api";
import { z } from "zod";
import { verificationToken } from "../lib/verification-gate.js";

export default defineChannel({
  routes: [
    POST("/test/verification/:sessionId/:key/release", async (_request, { params }) => {
      const { sessionId, key } = z
        .object({ sessionId: z.string().min(1).max(128), key: z.string().uuid() })
        .parse(params);
      const result = crypto.randomUUID();
      await resumeHook(verificationToken(sessionId, key), result);
      return Response.json({ released: true, result });
    }),
  ],
});
