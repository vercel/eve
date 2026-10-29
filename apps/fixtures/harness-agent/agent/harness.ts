import { defineHarness } from "eve";
import { defineTool } from "eve/tools";
import { z } from "zod";

// A playground for `agent/harness.ts`. It adds an account preamble and a tool to every model call,
// offers the agent's `remove_seat` only on the enterprise plan, and asks the model once per turn to
// cite its lookups before the turn ends.

const PLANS: Record<string, { readonly seats: number; readonly support: string }> = {
  free: { seats: 1, support: "community" },
  pro: { seats: 10, support: "email, next business day" },
  enterprise: { seats: 500, support: "24/7 phone" },
};

export default defineHarness((ctx) => {
  const plan = String(ctx.session.auth.current?.attributes.plan ?? "pro");
  return {
    agent: {
      // The agent's instructions, then the account's.
      instructions: (declared) => [
        ...Object.values(declared),
        `The customer is on the ${plan} plan.`,
      ],
      // The agent's tools and the harness's; only enterprise accounts get remove_seat.
      tools: ({ remove_seat, ...declared }) => ({
        ...declared,
        ...(plan === "enterprise" && { remove_seat: remove_seat! }),
        plan_lookup: defineTool({
          description: "Look up what a plan includes: its seats and its support.",
          inputSchema: z.object({ plan: z.enum(["free", "pro", "enterprise"]) }),
          execute: async ({ plan }) => PLANS[plan],
        }),
      }),
    },
    next: () => {
      const text = ctx.lastStep?.text;
      // Once per turn: an answer that used a lookup cites it.
      if (text == null || ctx.continuations > 0 || /\[\d+\]/.test(text)) return undefined;
      const looked = ctx.history.some(
        (message) =>
          message.role === "tool" &&
          message.content.some(
            (part) => part.type === "tool-result" && part.toolName === "plan_lookup",
          ),
      );
      return looked
        ? {
            model: { note: "Cite each plan_lookup result you used as [1], [2], … in your answer." },
          }
        : undefined;
    },
  };
});
