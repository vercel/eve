import { defineEval } from "eve/evals";

const PROBE_DIRECTIVE = "AUTHORED-BUNDLING-PROBE";

export default defineEval({
  description:
    "Static and runtime authored modules preserve their lifecycle and bundled asset semantics.",
  async test(t) {
    await t.send(PROBE_DIRECTIVE);

    t.succeeded();
    t.calledTool("bundle_probe", {
      output: {
        binaryAsset: "data:application/octet-stream;base64,RVZFLUJJTkFSWS1BU1NFVAo=",
        rawText: "authored runtime text\n",
        sharedModule: "shared-authored-typescript-module",
      },
    });
    t.messageIncludes(`${PROBE_DIRECTIVE}-COMPLETE`);
  },
});
