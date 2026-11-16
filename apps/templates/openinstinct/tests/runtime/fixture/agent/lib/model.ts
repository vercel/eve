import { MockLanguageModelV4 } from "ai/test";

export function fixtureModel(worker: boolean) {
  return new MockLanguageModelV4({
    // A catalog identity supplies context-window metadata; calls stay in this mock.
    provider: "openai",
    modelId: "gpt-5.4-mini",
    async doStream({ prompt, tools }) {
      const userIndex = prompt.findLastIndex(
        (message) => message.role === "user"
      );
      const user = prompt[userIndex];
      const text =
        user?.role === "user"
          ? user.content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("")
          : "";
      const returned = prompt
        .slice(userIndex + 1)
        .some((message) => message.role === "tool");
      let toolName: string | undefined;
      let input = "{}";
      const instructions = prompt
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n");
      if (instructions.includes("`final_output`")) {
        throw new Error(
          "Production instructions reference an unavailable completion tool."
        );
      }
      if (worker) {
        if (!instructions.includes("structured completion tool Eve supplies")) {
          throw new Error(
            "The runtime fixture must exercise the production completion instructions."
          );
        }
        toolName =
          text.includes("Wait for cancellation") && !returned
            ? "wait_for_cancellation"
            : "eve__reply";
        if (toolName === "eve__reply")
          input = JSON.stringify({
            status: "success",
            message: "Verified fixture outcome",
            images: [],
          });
      } else if (!returned && /^(Start|Wait|Resume:)/u.test(text)) {
        toolName = "run_browser";
        const assignment = {
          message: text.startsWith("Wait")
            ? "Wait for cancellation"
            : "Complete the fixture",
        };
        input = JSON.stringify(
          text.startsWith("Resume:")
            ? { ...assignment, taskId: text.slice(7) }
            : assignment
        );
      } else if (!returned && text.startsWith("Cancel:")) {
        toolName = "eve__task_cancel";
        input = JSON.stringify({ taskId: text.slice(7) });
      }
      if (toolName && !tools?.some((tool) => tool.name === toolName))
        throw new Error(`Missing fixture tool: ${toolName}`);
      const stream: Awaited<
        ReturnType<MockLanguageModelV4["doStream"]>
      >["stream"] = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (toolName)
            controller.enqueue({
              type: "tool-call",
              toolCallId: `fixture-${String(prompt.length)}`,
              toolName,
              input,
            });
          else {
            controller.enqueue({ type: "text-start", id: "reply" });
            controller.enqueue({
              type: "text-delta",
              id: "reply",
              delta: "Fixture turn settled.",
            });
            controller.enqueue({ type: "text-end", id: "reply" });
          }
          controller.enqueue({
            type: "finish",
            finishReason: {
              unified: toolName ? "tool-calls" : "stop",
              raw: undefined,
            },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          });
          controller.close();
        },
      });
      return { stream };
    },
  });
}
