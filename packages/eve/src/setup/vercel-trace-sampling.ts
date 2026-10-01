import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "#compiled/zod/index.js";
import { readVercelCliToken } from "#internal/model-auth/vercel-cli.js";
import { atomicWriteFile } from "#shared/atomic-write-file.js";

import { readProjectLink, type VercelProjectReference } from "./project-resolution.js";
import type { Prompter } from "./prompter.js";
import { WizardCancelledError } from "./step.js";

const TRACE_CONFIG_TIMEOUT_MS = 15_000;
const AGENT_PROJECT_TRACING_SAMPLING = [{ type: "head_sampling", rate: 1 }] as const;
const TracingConfigSchema = z.object({
  enabled: z.boolean(),
  sampling: z.array(z.unknown()),
});
const DeclinedOfferSchema = z.object({
  version: z.literal(1),
  orgId: z.string(),
  projectId: z.string(),
  decision: z.literal("declined"),
});

function offerPath(appRoot: string): string {
  return join(appRoot, ".eve", "trace-sampling.json");
}

async function declinedOffer(appRoot: string, link: VercelProjectReference): Promise<boolean> {
  try {
    const parsed = DeclinedOfferSchema.safeParse(
      JSON.parse(await readFile(offerPath(appRoot), "utf8")),
    );
    return (
      parsed.success && parsed.data.orgId === link.orgId && parsed.data.projectId === link.projectId
    );
  } catch {
    return false;
  }
}

async function readTraceSampling(
  link: VercelProjectReference,
  signal?: AbortSignal,
): Promise<number | undefined> {
  try {
    const token = await readVercelCliToken();
    if (token === undefined) return undefined;
    const tracingQuery = new URLSearchParams({
      projectId: link.projectId,
      teamId: link.orgId,
    });
    const response = await fetch(
      `https://api.vercel.com/v1/drains/tracing/config?${tracingQuery.toString()}`,
      {
        headers: { authorization: `Bearer ${token}` },
        method: "GET",
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(TRACE_CONFIG_TIMEOUT_MS)])
          : AbortSignal.timeout(TRACE_CONFIG_TIMEOUT_MS),
      },
    );
    if (!response.ok) return undefined;
    const parsed = TracingConfigSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.sampling.length : undefined;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

export async function configureTraceSampling(
  link: VercelProjectReference,
  prompter: Pick<Prompter, "log">,
  signal?: AbortSignal,
  context: "created" | "deployed" = "created",
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
      context === "created"
        ? "The Vercel project was created, but trace sampling could not be configured. Set it to 100% for all environments in the Vercel project settings."
        : "Deployment succeeded, but trace sampling could not be configured. Set it to 100% in the Vercel project settings.",
    );
  }
}

export async function offerTraceSampling(
  appRoot: string,
  projectId: string,
  prompter: Prompter,
  signal?: AbortSignal,
): Promise<void> {
  const link = await readProjectLink(appRoot);
  if (link === undefined || link.projectId !== projectId) return;
  if (await declinedOffer(appRoot, link)) return;

  const ruleCount = await readTraceSampling(link, signal);
  if (ruleCount === undefined) {
    prompter.log.warning(
      "Could not check Vercel trace sampling. Check the project's Tracing settings if you need Agent Runs.",
    );
    return;
  }
  if (ruleCount > 0) return;

  let choice: "enable" | "decline";
  try {
    choice = await prompter.select<"enable" | "decline">({
      message: "Enable tracing for Agent Runs?",
      description:
        "100% sampling applies to all environments and paths in this Vercel project. It collects traces for all project traffic and may incur tracing charges.",
      metadata: [{ label: "Vercel project", value: link.projectName ?? link.projectId }],
      options: [
        { value: "decline", label: "Not now" },
        { value: "enable", label: "Enable 100% sampling" },
      ],
      initialValue: "decline",
    });
  } catch (error) {
    if (error instanceof WizardCancelledError) return;
    throw error;
  }

  if (choice === "enable") {
    const latestRuleCount = await readTraceSampling(link, signal);
    if (latestRuleCount === undefined) {
      prompter.log.warning(
        "Deployment succeeded, but eve could not verify trace sampling before enabling it. Check the project's Tracing settings.",
      );
      return;
    }
    if (latestRuleCount > 0) return;
    await configureTraceSampling(link, prompter, signal, "deployed");
    return;
  }

  try {
    await mkdir(join(appRoot, ".eve"), { recursive: true });
    await atomicWriteFile(
      offerPath(appRoot),
      `${JSON.stringify({ version: 1, orgId: link.orgId, projectId: link.projectId, decision: "declined" }, null, 2)}\n`,
    );
  } catch {
    prompter.log.warning(
      "Could not remember your tracing choice; eve may ask again on a later deploy.",
    );
  }
}
