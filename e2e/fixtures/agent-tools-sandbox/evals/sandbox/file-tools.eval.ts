import { defineEval } from "eve/evals";

// The default `write_file` tool and opt-in framework `grep` tool both target
// the sandbox filesystem. Writing a unique token with `write_file`, then
// locating it with `grep`, proves they operate on the same `/workspace` as
// `bash`.
const FILE_TOOLS_TOKEN = "sandbox-file-tools-ok-Q2H";
const FILE_TOOLS_PATH = "/workspace/file-tools-note.txt";

export default defineEval({
  tags: ["real-model"],
  description: "Sandbox: write_file and opt-in grep operate on the sandbox filesystem.",
  async test(t) {
    await t.send(
      [
        `Use the write_file tool to create the file ${FILE_TOOLS_PATH} with exactly this content: ${FILE_TOOLS_TOKEN}`,
        `Then use the grep tool to search for ${FILE_TOOLS_TOKEN} under /workspace.`,
        "Reply with the matching line verbatim.",
      ].join("\n"),
    );

    t.succeeded();
    t.calledTool("write_file");
    t.calledTool("grep", {
      output: new RegExp(FILE_TOOLS_TOKEN),
    });
    t.messageIncludes(FILE_TOOLS_TOKEN);
  },
});
