import { z } from "zod";
import { canSendAgentFeedback, isAgentFeedbackEnabled } from "./availability";
import { agentFeedbackReportSchema, formatReport } from "./report";

// Pending sign-off from the collector owners.
const COLLECTOR_REPO = "eve-external";

export type SubmitResult =
  | { status: "sent" }
  | { status: "disabled" }
  | { status: "preview" }
  | { status: "failed"; rateLimited?: boolean };

export interface SubmitDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Per-network limit backed by a Vercel Firewall rate-limit rule. */
  checkRateLimit: () => Promise<{ rateLimited: boolean; error?: string }>;
  log?: (message: string, ...details: unknown[]) => void;
}

const submissionSchema = z.object({ structuredReport: z.string().trim().min(1).max(6000) });

const parseReport = (formData: FormData) => {
  const submission = submissionSchema.safeParse(Object.fromEntries(formData));
  if (!submission.success) return undefined;

  try {
    const report = agentFeedbackReportSchema.safeParse(
      JSON.parse(submission.data.structuredReport),
    );
    return report.success ? report.data : undefined;
  } catch {
    return undefined;
  }
};

export const submitAgentFeedbackReport = async (
  formData: FormData,
  { env = process.env, fetch: fetchImpl = fetch, checkRateLimit, log = console.error }: SubmitDeps,
): Promise<SubmitResult> => {
  const report = parseReport(formData);
  if (!report) return { status: "failed" };

  if (!isAgentFeedbackEnabled(env)) return { status: "disabled" };
  if (!canSendAgentFeedback(env)) return { status: "preview" };

  const ingestUrl = env.AGENT_FEEDBACK_INGEST_URL;
  const ingestToken = env.AGENT_FEEDBACK_INGEST_TOKEN;
  if (!ingestUrl || !ingestToken) {
    log("Agent feedback ingest URL or token is not configured.");
    return { status: "failed" };
  }

  try {
    const { rateLimited, error } = await checkRateLimit();
    if (rateLimited) return { status: "failed", rateLimited: true };
    if (error === "not-found") {
      // Fail closed: without the firewall rule, one network could flood the collector.
      log("Agent feedback rate limit is not configured.");
      return { status: "failed" };
    }

    const response = await fetchImpl(ingestUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ingestToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repo: COLLECTOR_REPO,
        type: "other",
        feedback: formatReport(report),
        severity: "info",
        agentType: report.agent,
        context: {
          source: "eve.dev/agent-feedback",
          eveVersion: report.eveVersion,
          triggerReason: report.triggerReason,
          report,
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      log("Agent feedback service rejected report:", response.status);
      return { status: "failed", rateLimited: response.status === 429 };
    }

    return { status: "sent" };
  } catch {
    log("Agent feedback submission failed.");
    return { status: "failed" };
  }
};
