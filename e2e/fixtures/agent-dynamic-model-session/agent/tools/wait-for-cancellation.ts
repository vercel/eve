import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

// A cancel aborts the tool within a second. The fallback only ends a wait
// whose abort never arrives, which the eval reports as a soft check: on
// Anthropic that has happened every run (the turn still settles cancelled),
// and waiting 90 s for it made this the slowest e2e-local leg.
const FALLBACK_TIMEOUT_MS = 15_000;

export default defineTool({
  description: "Waits until the current turn is cancelled.",
  inputSchema: z.object({}),
  approval: never(),
  execute(_input, ctx) {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve("wait-for-cancellation: fallback timeout reached without cancellation");
      }, FALLBACK_TIMEOUT_MS);

      const abort = (): void => {
        clearTimeout(timer);
        reject(ctx.abortSignal.reason);
      };
      if (ctx.abortSignal.aborted) {
        abort();
        return;
      }
      ctx.abortSignal.addEventListener("abort", abort, { once: true });
    });
  },
});
