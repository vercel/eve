import { createDeclarationCopier } from "../_shared.mjs";

export default {
  packageName: "@chat-adapter/state-memory",
  compiledPath: "@chat-adapter/state-memory",
  copyDeclarations: createDeclarationCopier({
    rewrites: {
      chat: { kind: "vendored", compiledPath: "chat" },
    },
  }),
};
