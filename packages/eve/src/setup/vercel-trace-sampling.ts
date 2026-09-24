import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "#compiled/zod/index.js";
import { atomicWriteFile } from "#shared/atomic-write-file.js";

import { captureVercel } from "./primitives/run-vercel.js";
import { readProjectLink, type VercelProjectReference } from "./project-resolution.js";
import type { Prompter } from "./prompter.js";
import { WizardCancelledError } from "./step.js";

const TRACE_CONFIG_TIMEOUT_MS = 15_000;
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

async function setTraceSampling(
  appRoot: string,
  link: VercelProjectReference,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await captureVercel(
    [
      "traces",
      "config",
      "set",
      "any",
      "100",
      "--json",
      "--project",
      link.projectId,
      "--scope",
      link.orgId,
    ],
    { cwd: appRoot, nonInteractive: true, signal, timeoutMs: TRACE_CONFIG_TIMEOUT_MS },
  );
  signal?.throwIfAborted();
  return result.ok;
}

export async function configureTraceSampling(
  link: VercelProjectReference,
  appRoot: string,
  prompter: Pick<Prompter, "log">,
  signal?: AbortSignal,
): Promise<void> {
  if (await setTraceSampling(appRoot, link, signal)) return;
  prompter.log.warning(
    "The Vercel project was created, but trace sampling could not be configured. Set it to 100% for all environments in the Vercel project settings.",
  );
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

  const rules = await captureVercel(
    ["traces", "config", "ls", "--json", "--project", link.projectId, "--scope", link.orgId],
    { cwd: appRoot, nonInteractive: true, signal, timeoutMs: TRACE_CONFIG_TIMEOUT_MS },
  );
  signal?.throwIfAborted();
  if (!rules.ok) {
    prompter.log.warning(
      "Could not check Vercel trace sampling rules. Check the project's Tracing settings if you need Agent Runs.",
    );
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rules.stdout);
  } catch {
    // An unknown response cannot establish that the project has no rules.
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && "rules" in parsed
      ? parsed.rules
      : undefined;
  if (!Array.isArray(entries)) {
    prompter.log.warning(
      "Could not read Vercel trace sampling rules. Check the project's Tracing settings if you need Agent Runs.",
    );
    return;
  }
  if (entries.length > 0) return;

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
    if (!(await setTraceSampling(appRoot, link, signal))) {
      prompter.log.warning(
        "Deployment succeeded, but trace sampling could not be configured. Set it to 100% in the Vercel project settings.",
      );
    }
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
