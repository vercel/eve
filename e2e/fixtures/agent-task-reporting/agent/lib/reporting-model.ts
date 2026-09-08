import type { LanguageModelMiddleware } from "ai";

export type PendingInstruction = "on" | "off";

export function reportingControl(instruction: PendingInstruction): string {
  return `<reporting-eval pending-instruction="${instruction}"/>\n`;
}

const PENDING_INSTRUCTION = "Background task control: incomplete cohort\n";

// Both arms remove their control marker before inference. Only the off arm
// removes the pending instruction; task state, results and other guidance stay.
export const reportingMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }) => {
    let instruction: PendingInstruction | undefined;
    const prompt = params.prompt.map((message) => {
      if (message.role !== "user") return message;
      return {
        ...message,
        content: message.content.map((part) => {
          if (part.type !== "text") return part;
          for (const variant of ["on", "off"] as const) {
            const control = reportingControl(variant);
            if (!part.text.startsWith(control)) continue;
            instruction = variant;
            return { ...part, text: part.text.slice(control.length) };
          }
          return part;
        }),
      };
    });

    if (instruction !== "off") return { ...params, prompt };

    return {
      ...params,
      prompt: prompt.filter(
        (message) =>
          !(
            message.role === "user" &&
            message.content.length === 1 &&
            message.content[0]?.type === "text" &&
            message.content[0].text.startsWith(PENDING_INSTRUCTION)
          ),
      ),
    };
  },
};
