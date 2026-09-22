import { mockModel } from "eve/evals";

export const NESTED_BACKGROUND = "Alice's nested verification";
export const NESTED_INTERIM = "Verification is running.";
export const NESTED_FINAL = "VERIFIED: harbor records are current.";

type Role = "parent" | "detector" | "worker";

export function nestedMessage(role: Role, key: string): string {
  return `${NESTED_BACKGROUND} ${JSON.stringify({ role, key })}`;
}

export const nestedBackgroundModel = mockModel({
  modelId: "nested-background-completion",
  respond(request) {
    const message = request.userMessages.find((text) => text.startsWith(NESTED_BACKGROUND));
    if (message === undefined) throw new Error("Missing nested verification scenario.");
    const { role, key } = JSON.parse(message.slice(NESTED_BACKGROUND.length)) as {
      role: Role;
      key: string;
    };
    if (role === "worker") {
      return request.toolResults.some((result) => result.name === "verification_gate")
        ? NESTED_FINAL
        : { toolCalls: [{ name: "verification_gate", input: { key } }] };
    }

    const tool = role === "parent" ? "remote-loopback" : "agent";
    const state = [...request.userMessages]
      .reverse()
      .find((text) => text.startsWith("[Task state]\n"));
    if (state !== undefined) {
      const { tasks } = JSON.parse(state.slice("[Task state]\n".length)) as {
        tasks: { name: string; status: string; output?: { type: string; data: unknown } }[];
      };
      const completed = tasks.find((task) => task.name === tool && task.status === "completed");
      if (completed !== undefined) {
        if (completed.output?.type !== "result" || typeof completed.output.data !== "string") {
          throw new Error("Completed verification task has no text result.");
        }
        // Echo the actual task result. Never manufacture the expected final marker.
        return completed.output.data;
      }
    }
    if (request.toolResults.some((result) => result.name === tool)) return NESTED_INTERIM;
    return {
      toolCalls: [
        {
          name: tool,
          input: { message: nestedMessage(role === "parent" ? "detector" : "worker", key) },
        },
      ],
    };
  },
});
