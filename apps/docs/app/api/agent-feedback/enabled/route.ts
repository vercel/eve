import { connection } from "next/server";
import { isAgentFeedbackEnabled } from "@/lib/agent-feedback/availability";

/**
 * Kill switch read by `eve internal agent-feedback-instructions`. The CLI
 * treats anything but a 200 with the exact body `true` as off.
 */
export const GET = async () => {
  await connection();

  return new Response(isAgentFeedbackEnabled() ? "true" : "false", {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
};
