import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

// Under the mock model, a deterministic stand-in for the support model the harness wraps.
const config = e2eAgentConfig({
  mock: ({ lastUserMessage, messages, tools, toolResults }) => {
    const looked = toolResults.find((entry) => entry.name === "plan_lookup");
    if (looked !== undefined) {
      const noted = messages.some((m) => m.role === "user" && m.text.includes("Cite each"));
      const seats = (looked.output as { seats?: number } | undefined)?.seats;
      return noted
        ? `The enterprise plan includes ${seats} seats [1].`
        : `The enterprise plan includes ${seats} seats.`;
    }
    if (lastUserMessage?.includes("how many seats")) {
      return { toolCalls: [{ name: "plan_lookup", input: { plan: "enterprise" } }] };
    }
    if (lastUserMessage?.includes("remove")) {
      return tools.some((tool) => tool.name === "remove_seat")
        ? { toolCalls: [{ name: "remove_seat", input: { email: "bob@example.com" } }] }
        : "Removing seats isn't available on your plan.";
    }
    return `Mock reply: ${lastUserMessage ?? ""}`;
  },
});

export default defineAgent(config);
