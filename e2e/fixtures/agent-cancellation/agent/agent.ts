import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent(
  e2eAgentConfig({
    mock: (request) => {
      const message = request.lastUserMessage ?? "";
      if (message.includes("Please wait for cancellation.")) {
        return {
          toolCalls: [{ id: "wait-for-cancellation", input: {}, name: "wait-for-cancellation" }],
        };
      }
      const markers = [...message.matchAll(/record-request with marker "([^"]+)"/gu)].map(
        (match) => match[1]!,
      );
      if (markers.length > 0) {
        const pending = markers.filter(
          (marker) => !request.toolResults.some((entry) => entry.id === `record-${marker}`),
        );
        return pending.length > 0
          ? {
              toolCalls: pending.map((marker) => ({
                id: `record-${marker}`,
                input: { marker },
                name: "record-request",
              })),
            }
          : markers
              .map((marker) =>
                String(request.toolResults.find((entry) => entry.id === `record-${marker}`)?.output),
              )
              .join("\n");
      }
      return `Mock reply: ${message}`;
    },
  }),
);
