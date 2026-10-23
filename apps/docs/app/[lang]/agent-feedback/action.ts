"use server";

import { checkRateLimit } from "@vercel/firewall";
import { type SubmitResult, submitAgentFeedbackReport } from "@/lib/agent-feedback/submit";

export const submitAgentFeedback = async (
  _previous: SubmitResult | undefined,
  formData: FormData,
): Promise<SubmitResult> =>
  submitAgentFeedbackReport(formData, {
    checkRateLimit: () => checkRateLimit("rl_eve_agent_feedback"),
  });
