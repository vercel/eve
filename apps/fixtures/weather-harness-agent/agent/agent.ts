import { defineAgent } from "eve";
import { codex } from "@ai-sdk/harness-codex";

export default defineAgent({
  build: {
    externalDependencies: ["@ai-sdk/harness-codex"],
  },
  harness: codex,
});
