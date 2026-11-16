import { defineEval } from "eve/evals";

// The file tools resolve relative paths from the workspace root, where `bash`
// commands start. A note written and read back by relative path, finalized by
// `edit_file`, found by `grep` under a relative directory, and printed by `cat`
// from the default working directory proves all five tools share one root.
const FILE_TOOLS_DRAFT = "sandbox-file-tools-draft-Q2H";
const FILE_TOOLS_TOKEN = "sandbox-file-tools-ok-Q2H";
const FILE_TOOLS_PATH = "notes/handoff.txt";

export default defineEval({
  description: "Sandbox: file tools and bash resolve relative paths from one workspace root.",
  async test(t) {
    await t.send(
      [
        "EVE_SANDBOX_FILE_TOOLS",
        "Alice is leaving a handoff note for Bob in the workspace.",
        `Use the write_file tool to create ${FILE_TOOLS_PATH} with exactly this content: ${FILE_TOOLS_DRAFT}`,
        `Then read ${FILE_TOOLS_PATH} back with the read_file tool.`,
        `Alice finished the note, so use the edit_file tool to replace ${FILE_TOOLS_DRAFT} with ${FILE_TOOLS_TOKEN} in ${FILE_TOOLS_PATH}.`,
        `Then use the grep tool to search for ${FILE_TOOLS_TOKEN} in notes with outputMode content.`,
        `Finally, run the bash command \`cat ${FILE_TOOLS_PATH}\` and reply with its output verbatim.`,
      ].join("\n"),
    );

    t.succeeded();
    t.calledTool("write_file", { output: { path: /^\/.+\/notes\/handoff\.txt$/u } });
    t.calledTool("edit_file", { output: { path: /notes\/handoff\.txt$/u, replacements: 1 } });
    // The scripted model runs every step; a live model may skip the read-back and search.
    if (process.env.EVE_E2E_MODEL === "mock") {
      t.calledTool("read_file", { output: { content: new RegExp(FILE_TOOLS_DRAFT) } });
      t.calledTool("grep", { output: new RegExp(FILE_TOOLS_TOKEN) });
    }
    t.calledTool("bash", { output: { stdout: new RegExp(FILE_TOOLS_TOKEN) } });
    t.messageIncludes(FILE_TOOLS_TOKEN);
  },
});
