import { builtins, declared, defineHarness } from "eve/experimental/harness";
import { defineTool } from "eve/tools";
import { z } from "zod";

// A playground for `agent/harness.ts`. It adds an account preamble and a tool to every model call,
// answers `/plans` without the model, refuses `/refund`, offers the agent's `remove_seat` only on
// the enterprise plan, and asks the model once per turn to cite its lookups.

const PLANS: Record<string, { readonly seats: number; readonly support: string }> = {
  free: { seats: 1, support: "community" },
  pro: { seats: 10, support: "email, next business day" },
  enterprise: { seats: 500, support: "24/7 phone" },
};

export default defineHarness((ctx) => {
  const plan = String(ctx.session.auth.current?.attributes.plan ?? "pro");
  const input = ctx.turn?.input
    .flatMap((part) => (part.kind === "text" ? [part.text] : []))
    .join(" ");
  return {
    agent: {
      // eve's default prompt for what the agent declares, then the account's.
      instructions: async () => {
        const prompt = builtins(ctx).prompt.instructions(await declared(ctx));
        return [
          ...(typeof prompt === "string" ? [prompt] : prompt),
          `The customer is on the ${plan} plan.`,
        ];
      },
      // The agent's tools, eve's, and two of the harness's; only enterprise accounts get remove_seat.
      tools: async () => {
        const { remove_seat, ...tools } = (await declared(ctx)).tools;
        return {
          ...tools,
          ...builtins(ctx).tools,
          ...(plan === "enterprise" && remove_seat !== undefined && { remove_seat }),
          plan_lookup: defineTool({
            description: "Look up what a plan includes: its seats and its support.",
            inputSchema: z.object({ plan: z.enum(["free", "pro", "enterprise"]) }),
            execute: async ({ plan }) => PLANS[plan],
          }),
        };
      },
    },
    next: () => {
      if (ctx.steps === 0) {
        // Commands, before the model runs.
        if (input?.trim() === "/plans") {
          const lines = Object.entries(PLANS).map(
            ([name, { seats, support }]) => `- ${name}: ${seats} seats, ${support} support`,
          );
          return { settle: { output: lines.join("\n") } };
        }
        if (input?.trim().startsWith("/refund")) {
          return { fail: { message: "Refunds go through billing@example.com." } };
        }
        return undefined;
      }
      // Before a model call that reads tool results, there's no answer to check yet.
      if (ctx.lastStep === undefined) return undefined;
      // Once per turn: an answer that used a lookup cites it.
      const text = ctx.lastStep.text;
      const looked = ctx.calls.some((call) => call.tool === "plan_lookup");
      if (text == null || !looked || ctx.continuations > 0 || /\[\d+\]/.test(text))
        return undefined;
      return {
        model: { note: "Cite each plan_lookup result you used as [1], [2], … in your answer." },
      };
    },
  };
});
