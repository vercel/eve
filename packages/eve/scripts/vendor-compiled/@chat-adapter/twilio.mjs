import { createDeclarationCopier } from "../_shared.mjs";

export default {
  packageName: "@chat-adapter/twilio",
  compiledPath: "@chat-adapter/twilio",
  entries: [
    {
      outputPath: "index",
    },
    {
      input: "@chat-adapter/twilio/api",
      outputPath: "api",
    },
    {
      input: "@chat-adapter/twilio/webhook",
      outputPath: "webhook",
    },
    {
      input: "@chat-adapter/twilio/voice",
      outputPath: "voice",
    },
    {
      input: "@chat-adapter/twilio/format",
      outputPath: "format",
    },
  ],
  copyDeclarations: createDeclarationCopier({
    files: [
      { source: "index.d.ts", output: "index.d.ts" },
      { source: "api.d.ts", output: "api.d.ts" },
      { source: "webhook.d.ts", output: "webhook.d.ts" },
      { source: "voice.d.ts", output: "voice.d.ts" },
      { source: "format.d.ts", output: "format.d.ts" },
    ],
    rewrites: {
      chat: { kind: "vendored", compiledPath: "chat" },
    },
  }),
};
