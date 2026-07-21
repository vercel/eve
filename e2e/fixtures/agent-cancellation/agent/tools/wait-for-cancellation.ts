import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

const FALLBACK_TIMEOUT_MS = 90_000;

export default defineTool({
  description:
    "Waits until the current turn is cancelled. Only call when the user explicitly asks you to wait for cancellation.",
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
