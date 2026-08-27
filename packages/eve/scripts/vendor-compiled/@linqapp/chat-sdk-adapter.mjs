import { createDeclarationCopier } from "../_shared.mjs";

export default {
  packageName: "@linqapp/chat-sdk-adapter",
  compiledPath: "@linqapp/chat-sdk-adapter",
  copyDeclarations: createDeclarationCopier({
    rewrites: {
      chat: { kind: "vendored", compiledPath: "chat" },
      "@linqapp/sdk": { kind: "external" },
      standardwebhooks: { kind: "external" },
    },
  }),
};
