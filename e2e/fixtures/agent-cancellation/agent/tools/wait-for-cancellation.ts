import { vercelOidc } from "eve/agents/auth";
import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

const FALLBACK_TIMEOUT_MS = 90_000;
const VERCEL_TRUSTED_OIDC_HEADER = "x-vercel-trusted-oidc-idp-token";

interface CancelTurnResponse {
  readonly ok?: boolean;
  readonly sessionId?: string;
  readonly status?: string;
}

export default defineTool({
  description:
    "Cancels its current turn through the eve HTTP channel. Only call when the user explicitly asks to test cancellation, and use the exact baseUrl they provide.",
  inputSchema: z.object({ baseUrl: z.string().url() }),
  approval: never(),
  async execute(input, ctx) {
    const response = await fetch(
      new URL(`/eve/v1/session/${encodeURIComponent(ctx.session.id)}/cancel`, input.baseUrl),
      { headers: await resolveHeaders(), method: "POST" },
    );
    const payload = (await response.json().catch(() => null)) as CancelTurnResponse | null;
    if (
      response.status !== 202 ||
      payload?.ok !== true ||
      payload.sessionId !== ctx.session.id ||
      payload.status !== "cancelling"
    ) {
      throw new Error(`Cancel route returned ${response.status}: ${JSON.stringify(payload)}`);
    }

    return await new Promise<string>((resolve, reject) => {
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

async function resolveHeaders(): Promise<Record<string, string> | undefined> {
  if (process.env.VERCEL !== "1") return undefined;

  const { headers } = await vercelOidc()();
  const authorization = headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  return token === undefined ? { ...headers } : { ...headers, [VERCEL_TRUSTED_OIDC_HEADER]: token };
}
