import { readVercelCliToken } from "#internal/model-auth/vercel-cli.js";

import type { VercelProjectReference } from "./project-resolution.js";
import type { Prompter } from "./prompter.js";

const AGENT_PROJECT_TRACING_SAMPLING = [{ type: "head_sampling", rate: 1 }] as const;

export async function configureTraceSampling(
  link: VercelProjectReference,
  prompter: Pick<Prompter, "log">,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const token = await readVercelCliToken();
    if (token === undefined) throw new Error("Vercel CLI credentials are unavailable.");
    const tracingQuery = new URLSearchParams({
      projectId: link.projectId,
      teamId: link.orgId,
    });
    const response = await fetch(
      `https://api.vercel.com/v1/drains/tracing/config?${tracingQuery.toString()}`,
      {
        body: JSON.stringify({
          enabled: true,
          sampling: AGENT_PROJECT_TRACING_SAMPLING,
        }),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method: "PUT",
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      throw new Error("Vercel rejected the trace sampling configuration.");
    }
  } catch {
    signal?.throwIfAborted();
    prompter.log.warning(
      "The Vercel project was created, but trace sampling could not be configured. Set it to 100% for all environments in the Vercel project settings.",
    );
  }
}
