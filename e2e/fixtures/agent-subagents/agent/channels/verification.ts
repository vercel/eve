import { defineChannel, POST } from "eve/channels";
import { getHookByToken, getRun, resumeHook } from "workflow/api";
import { z } from "zod";
import { verificationNamespace, type VerificationGate } from "../lib/verification-gate.js";

// The random per-eval key is a capability for only that worker's fixture gate.
export default defineChannel({
  routes: [
    POST("/test/verification/:sessionId/:key/:action", async (request, { params }) => {
      const { sessionId, key, action } = z
        .object({
          sessionId: z.string().min(1).max(128),
          key: z.string().uuid(),
          action: z.enum(["ready", "release", "status"]),
        })
        .parse(params);
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]);
      const reader = getRun(sessionId)
        .getReadable<VerificationGate>({ namespace: verificationNamespace(key), startIndex: 0 })
        .getReader();
      const abort = () => {
        void reader.cancel();
      };
      signal.addEventListener("abort", abort, { once: true });
      let gate: VerificationGate;
      try {
        signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) throw new Error("Verification gate was not acknowledged.");
        gate = next.value;
      } finally {
        signal.removeEventListener("abort", abort);
        await reader.cancel();
        reader.releaseLock();
      }
      // Cancellation disposes the hook; the published run identity remains readable.
      if (action === "status") return Response.json({ status: await getRun(gate.runId).status });
      const hook = await getHookByToken(gate.token);
      const metadata = await hook.metadata;
      if (
        metadata === null ||
        typeof metadata !== "object" ||
        Reflect.get(metadata, "sessionId") !== sessionId ||
        Reflect.get(metadata, "key") !== key
      ) {
        return new Response(null, { status: 403 });
      }
      if (action === "ready") return Response.json({ status: await getRun(hook.runId).status });
      const result = `VERIFIED: ${crypto.randomUUID()}`;
      await resumeHook(gate.token, result);
      return Response.json({ released: true, result });
    }),
  ],
});
