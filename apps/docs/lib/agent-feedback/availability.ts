/**
 * The kill switch for agent feedback. The review page, the submit action, and
 * `/api/agent-feedback/enabled` (read by the eve CLI before it gives agents
 * reporting instructions) all follow this value. Anything but `"true"` is off.
 */
export const isAgentFeedbackEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.EVE_AGENT_FEEDBACK_ENABLED === "true";

/** Only production deployments forward reports; previews and local dev never send. */
export const canSendAgentFeedback = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.VERCEL_ENV === "production";
