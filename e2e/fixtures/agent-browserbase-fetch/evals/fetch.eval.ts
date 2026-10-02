import { defineEval } from "eve/evals";

const TARGET_URL = "https://example.com/";

export default defineEval({
  tags: ["real-model"],
  description: "Browserbase Gateway fetch extracts a public page using the authored JSON schema.",
  async test(t) {
    const turn = await t.send(
      [
        "Bob is adding a summary of the public example page to an onboarding guide.",
        `Use web_fetch once with URL ${JSON.stringify(TARGET_URL)}.`,
        "Report the page's title and purpose using the returned structured fields.",
      ].join("\n"),
    );

    turn.expectOk();
    turn.calledTool("web_fetch", {
      count: 1,
      input: { url: TARGET_URL },
      output: (value) => {
        if (
          typeof value !== "object" ||
          value === null ||
          !("statusCode" in value) ||
          !("content" in value) ||
          !("contentType" in value)
        ) {
          return false;
        }
        const content = value.content;
        return (
          value.statusCode === 200 &&
          typeof value.contentType === "string" &&
          value.contentType.includes("json") &&
          typeof content === "object" &&
          content !== null &&
          "title" in content &&
          typeof content.title === "string" &&
          /^example domains?$/i.test(content.title) &&
          "purpose" in content &&
          typeof content.purpose === "string" &&
          content.purpose.toLowerCase().includes("documentation")
        );
      },
    });
    turn.noFailedActions();
    turn.messageIncludes("Example Domain");
  },
});
