import { defineEval } from "eve/evals";

// The file tools resolve relative paths from the workspace root, where `bash`
// commands start. A note written and read back by relative path, found by
// `grep` under a relative directory, and printed by `cat` from the default
// working directory proves all four tools share one root.
const FILE_TOOLS_TOKEN = "sandbox-file-tools-ok-Q2H";
const FILE_TOOLS_PATH = "notes/handoff.txt";

export default defineEval({
  description: "Sandbox: file tools and bash resolve relative paths from one workspace root.",
  async test(t) {
    await t.send(
      [
        "EVE_SANDBOX_FILE_TOOLS",
        "Alice is leaving a handoff note for Bob in the workspace.",
        `Use the write_file tool to create ${FILE_TOOLS_PATH} with exactly this content: ${FILE_TOOLS_TOKEN}`,
        `Then read ${FILE_TOOLS_PATH} back with the read_file tool.`,
        `Then use the grep tool to search for ${FILE_TOOLS_TOKEN} in notes.`,
        `Finally, run the bash command \`cat ${FILE_TOOLS_PATH}\` and reply with its output verbatim.`,
      ].join("\n"),
    );

    t.succeeded();
    t.calledTool("write_file", { output: { path: /^\/.+\/notes\/handoff\.txt$/u } });
    // The scripted model runs every step; a live model may skip the read-back and search.
    if (process.env.EVE_E2E_MODEL === "mock") {
      t.calledTool("read_file", { output: { content: new RegExp(FILE_TOOLS_TOKEN) } });
      t.calledTool("grep", { output: new RegExp(FILE_TOOLS_TOKEN) });
    }
    t.calledTool("bash", { output: { stdout: new RegExp(FILE_TOOLS_TOKEN) } });
    t.messageIncludes(FILE_TOOLS_TOKEN);
  },
});
