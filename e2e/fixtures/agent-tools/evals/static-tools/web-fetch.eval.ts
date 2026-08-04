import { defineEval } from "eve/evals";

const TOOL_NAME = "web_fetch";
const TARGET_URL = "https://example.com/";
const CONTENT_MARKER = "Example Domain";

export default defineEval({
  tags: ["real-model"],
  description: "Framework tools smoke: web_fetch retrieves an HTTPS page.",
  async test(t) {
    const turn = await t.send({
      message: [
        `Call \`${TOOL_NAME}\` exactly once with URL ${JSON.stringify(TARGET_URL)} and format "text".`,
        "Do not call any other tools.",
        `After the tool returns, reply with the page title: ${CONTENT_MARKER}.`,
      ].join("\n"),
    });

    turn.expectOk();
    turn.calledTool(TOOL_NAME, {
      count: 1,
      input: {
        format: "text",
        url: TARGET_URL,
      },
      output: (value) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          return false;
        }
        const result = value as Record<string, unknown>;
        return (
          typeof result.content === "string" &&
          result.content.includes(CONTENT_MARKER) &&
          typeof result.contentType === "string" &&
          result.contentType.includes("text/html") &&
          result.truncated === false &&
          result.url === TARGET_URL
        );
      },
    });
    turn.noFailedActions();
    turn.messageIncludes(CONTENT_MARKER);
  },
});
